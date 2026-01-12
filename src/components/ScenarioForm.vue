<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import type { StoredScenario, StepImage, FormImageData } from '../types';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_SIZE,
} from '../constants/hintImages';

// UI display constants for explaining API limits (not enforced at save time)
const UI_MAX_FILE_SIZE_MB = Math.round(MAX_FILE_SIZE / 1024 / 1024);
const UI_MAX_TOTAL_SIZE_MB = Math.round(MAX_TOTAL_SIZE / 1024 / 1024);

const props = defineProps<{
  scenario?: StoredScenario | null;
  visible: boolean;
  existingImages?: StepImage[];
  saveError?: string;
}>();

const emit = defineEmits<{
  save: [title: string, description: string, images: FormImageData[]];
  cancel: [];
}>();

const title = ref('');
const description = ref('');
const images = ref<FormImageData[]>([]);
const isDragging = ref(false);
const imageError = ref('');
const isProcessingImages = ref(false);

// File input ref for fallback
const fileInputRef = ref<HTMLInputElement | null>(null);

const isEditing = computed(() => !!props.scenario);
const modalTitle = computed(() =>
  isEditing.value ? 'テストステップ編集' : '新規テストステップ登録'
);

// Title is optional, only description is required
// Also disabled while processing images to prevent saving incomplete data
const canSave = computed(
  () => description.value.trim().length > 0 && !isProcessingImages.value
);

// Title placeholder: shows auto-generated preview
const titlePlaceholder = computed(() => {
  if (description.value.trim()) {
    const firstLine = description.value.split('\n')[0].trim();
    const preview =
      firstLine.length > 20 ? firstLine.substring(0, 20) + '...' : firstLine;
    return `未入力の場合: 「${preview}」`;
  }
  return 'タイトル（省略可 - 本文から自動生成）';
});

// Visible images (excluding deleted ones)
const visibleImages = computed(() =>
  images.value.filter((img) => !img.markedForDeletion)
);

// Initialize images from props
function initializeImages() {
  if (props.existingImages && props.existingImages.length > 0) {
    images.value = props.existingImages.map((img) => ({
      existingId: img.id,
      base64: img.image_data,
      fileName: img.file_name,
      mimeType: img.mime_type,
      markedForDeletion: false,
    }));
  } else {
    images.value = [];
  }
  imageError.value = '';
  fileWarning.value = '';
  imageLimitWarning.value = '';
}

// Initialize on mount
onMounted(() => {
  initializeImages();
});

// Watch scenario changes for re-initialization
watch(
  () => props.scenario,
  (newVal) => {
    if (newVal) {
      title.value = newVal.title;
      description.value = newVal.description;
    } else {
      title.value = '';
      description.value = '';
    }
  },
  { immediate: true }
);

// Watch visible changes for re-initialization
watch(
  () => props.visible,
  (newVal) => {
    if (newVal) {
      // Re-initialize from props.scenario when becoming visible
      if (props.scenario) {
        title.value = props.scenario.title;
        description.value = props.scenario.description;
      } else {
        title.value = '';
        description.value = '';
      }
      // Re-initialize images when form opens
      initializeImages();
    }
  }
);

// Watch existingImages changes
watch(
  () => props.existingImages,
  () => {
    if (props.visible) {
      initializeImages();
    }
  },
  { deep: true }
);

// Image limit constants are imported from ../constants/hintImages
// These limits are based on Claude API constraints:
// - MAX_IMAGE_COUNT: 20 (20+ images trigger 2000px dimension limit)
// - MAX_FILE_SIZE: 5MB per file
// - MAX_TOTAL_SIZE: 15MB total (32MB API limit minus screenshot buffer)

// Warning states
// API limit warning (recalculated on visibleImages change)
const imageLimitWarning = ref('');
// Individual file warnings (set during processFiles, persists until next upload)
const fileWarning = ref('');

// Calculate total size of visible images (base64 to approximate bytes)
function calculateTotalImageSize(): number {
  return visibleImages.value.reduce((total, img) => {
    // base64 string length * 0.75 ≈ original bytes
    return total + Math.ceil(img.base64.length * 0.75);
  }, 0);
}

// Recalculate warning based on current visible images
function recalculateWarning(): void {
  const totalCount = visibleImages.value.length;
  const totalSize = calculateTotalImageSize();

  if (totalCount > MAX_IMAGE_COUNT || totalSize > MAX_TOTAL_SIZE) {
    const limitWarnings: string[] = [];
    if (totalCount > MAX_IMAGE_COUNT) {
      limitWarnings.push(`${MAX_IMAGE_COUNT}枚`);
    }
    if (totalSize > MAX_TOTAL_SIZE) {
      limitWarnings.push(`${UI_MAX_TOTAL_SIZE_MB}MB`);
    }
    imageLimitWarning.value = `※ API制限（${limitWarnings.join('・')}まで）を超えています。送信時に一部の画像が除外されます。`;
  } else {
    imageLimitWarning.value = '';
  }
}

// Watch visibleImages changes to recalculate warning
// Skip during processFiles to avoid overwriting individual file warnings
watch(
  visibleImages,
  () => {
    if (!isProcessingImages.value) {
      recalculateWarning();
    }
  },
  { deep: true }
);

// Normalize MIME type (image/jpg -> image/jpeg for Claude API compatibility)
function normalizeMimeType(mimeType: string): string {
  return mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
}

// Convert File to Base64
async function fileToBase64(
  file: File
): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // "data:image/png;base64,xxxx" -> "xxxx"
      const base64 = dataUrl.split(',')[1];
      const mimeType = dataUrl.split(':')[1].split(';')[0];
      resolve({ base64, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Process files (from drop or file input)
// NOTE: No count/total size limits at save time - all images are saved.
// API constraints are applied at send time (trimHintImagesToLimit in scenarioRunner.ts)
async function processFiles(files: FileList | File[]) {
  imageError.value = '';
  fileWarning.value = '';
  const fileWarnings: string[] = [];
  const errors: string[] = [];
  isProcessingImages.value = true;

  try {
    const fileArray = Array.from(files);

    // Process all files - save is unlimited, API limits apply at send time
    for (const file of fileArray) {
      // Validate MIME type - reject unsupported formats
      if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
        errors.push(`${file.name}: サポートされていない形式です（PNG, JPG, GIF, WebPのみ）`);
        continue;
      }

      // Warn about large files but still allow them (they will be excluded at send time)
      if (file.size > MAX_FILE_SIZE) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        fileWarnings.push(`${file.name}: ${sizeMB}MBは送信時に除外される可能性があります（1枚${UI_MAX_FILE_SIZE_MB}MB以下推奨）`);
      }

      try {
        const { base64, mimeType } = await fileToBase64(file);
        images.value.push({
          base64,
          fileName: file.name,
          mimeType: normalizeMimeType(mimeType),
          markedForDeletion: false,
        });
      } catch (error) {
        errors.push(`${file.name}: 読み込みに失敗しました`);
      }
    }

    // Show individual file warnings (non-blocking)
    if (fileWarnings.length > 0) {
      fileWarning.value = fileWarnings.join('\n');
    }

    // Show errors (blocking for those files only)
    if (errors.length > 0) {
      imageError.value = errors.join('\n');
    }

    // Recalculate API limit warning
    recalculateWarning();
  } finally {
    isProcessingImages.value = false;
  }
}

// Drag and drop handlers
function handleDragOver(event: DragEvent) {
  event.preventDefault();
  isDragging.value = true;
}

function handleDragLeave(event: DragEvent) {
  event.preventDefault();
  isDragging.value = false;
}

async function handleDrop(event: DragEvent) {
  event.preventDefault();
  isDragging.value = false;

  const files = event.dataTransfer?.files;
  if (files && files.length > 0) {
    await processFiles(files);
  }
}

// File input handler
async function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    await processFiles(input.files);
    // Reset input to allow selecting the same file again
    input.value = '';
  }
}

// Click to open file dialog
function openFileDialog() {
  fileInputRef.value?.click();
}

// Remove image
function removeImage(index: number) {
  const actualIndex = findActualIndex(index);
  if (actualIndex === -1) return;

  const image = images.value[actualIndex];
  if (image.existingId) {
    // Mark existing image for deletion
    image.markedForDeletion = true;
  } else {
    // Remove new image from array
    images.value.splice(actualIndex, 1);
  }
}

// Find actual index in images array from visible index
function findActualIndex(visibleIndex: number): number {
  let count = 0;
  for (let i = 0; i < images.value.length; i++) {
    if (!images.value[i].markedForDeletion) {
      if (count === visibleIndex) return i;
      count++;
    }
  }
  return -1;
}

// Get image data URL for display
function getImageDataUrl(image: FormImageData): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

function handleSave() {
  if (!canSave.value) return;
  // Title can be empty - will be auto-generated by service
  emit('save', title.value.trim(), description.value.trim(), images.value);
}

function handleCancel() {
  emit('cancel');
}
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="handleCancel">
    <div class="modal scenario-form-modal">
      <h2>{{ modalTitle }}</h2>

      <!-- Save error message (displayed in modal) -->
      <div v-if="saveError" class="save-error-box">
        {{ saveError }}
      </div>

      <div class="form-group">
        <label for="title-input"
          >タイトル <span class="optional-label">（省略可）</span></label
        >
        <input
          id="title-input"
          v-model="title"
          type="text"
          :placeholder="titlePlaceholder"
        />
        <p class="hint-text">
          未入力の場合、テストステップ内容の先頭から自動生成されます
        </p>
      </div>
      <div class="form-group">
        <label for="description-input"
          >テストステップ内容 <span class="required-label">*</span></label
        >
        <textarea
          id="description-input"
          v-model="description"
          rows="10"
          placeholder="テストステップの詳細を入力...

例:
1. Chromeを開く
2. google.comにアクセス
3. 'Tauri framework'を検索"
        ></textarea>
      </div>

      <!-- Image Drop Zone -->
      <div class="form-group">
        <label>ヒント画像 <span class="optional-label">（省略可）</span></label>
        <p class="hint-text image-hint">
          クリック対象や探してほしい要素のスクリーンショットをドラッグ&ドロップで追加できます<br />
          <span class="limit-text">※ 保存は無制限、送信時はAPI制限（{{ MAX_IMAGE_COUNT }}枚・{{ UI_MAX_TOTAL_SIZE_MB }}MBまで）に合わせて自動選別されます</span>
        </p>
        <div
          class="drop-zone"
          :class="{ dragging: isDragging }"
          @dragover="handleDragOver"
          @dragleave="handleDragLeave"
          @drop="handleDrop"
          @click="openFileDialog"
        >
          <input
            ref="fileInputRef"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            class="file-input"
            @change="handleFileSelect"
          />
          <div class="drop-zone-content">
            <span class="drop-icon">+</span>
            <span class="drop-text">
              画像をドラッグ&ドロップ<br />またはクリックして選択
            </span>
          </div>
        </div>

        <!-- Processing indicator -->
        <p v-if="isProcessingImages" class="processing-text">
          画像を読み込み中...
        </p>

        <!-- Warning messages -->
        <p v-if="fileWarning" class="warning-text">
          {{ fileWarning }}
        </p>
        <p v-if="imageLimitWarning" class="warning-text">
          {{ imageLimitWarning }}
        </p>

        <!-- Error message -->
        <p v-if="imageError" class="error-text">{{ imageError }}</p>

        <!-- Image previews -->
        <div v-if="visibleImages.length > 0" class="image-previews">
          <div
            v-for="(image, index) in visibleImages"
            :key="image.existingId || `new-${index}`"
            class="image-preview"
          >
            <img :src="getImageDataUrl(image)" :alt="image.fileName" />
            <div class="image-info">
              <span class="image-name">{{ image.fileName }}</span>
            </div>
            <button
              type="button"
              class="remove-image-btn"
              @click.stop="removeImage(index)"
              title="削除"
            >
              ×
            </button>
          </div>
        </div>
      </div>

      <div class="button-row">
        <button @click="handleCancel" class="secondary-button">
          キャンセル
        </button>
        <button @click="handleSave" class="primary-button" :disabled="!canSave">
          {{ isEditing ? '保存' : '登録' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal {
  background: white;
  padding: 24px;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  width: 90%;
  max-width: 600px;
  max-height: 90vh;
  overflow-y: auto;
}
@media (prefers-color-scheme: dark) {
  .modal {
    background: #2a2a2a;
    color: #f6f6f6;
  }
}
.scenario-form-modal h2 {
  margin-top: 0;
  margin-bottom: 20px;
}
.save-error-box {
  padding: 12px 16px;
  border-radius: 6px;
  margin-bottom: 16px;
  background-color: #f8d7da;
  border: 1px solid #f5c6cb;
  color: #721c24;
  font-size: 13px;
  white-space: pre-line;
}
@media (prefers-color-scheme: dark) {
  .save-error-box {
    background-color: #2c0b0e;
    border-color: #491217;
    color: #f5c6cb;
  }
}
.form-group {
  margin-bottom: 16px;
}
.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
}
.optional-label {
  font-weight: normal;
  color: #888;
  font-size: 0.9em;
}
.required-label {
  color: #dc3545;
}
.hint-text {
  font-size: 12px;
  color: #888;
  margin-top: 4px;
  margin-bottom: 0;
}
.image-hint {
  margin-bottom: 8px;
}
.limit-text {
  color: #666;
  font-size: 11px;
}
@media (prefers-color-scheme: dark) {
  .limit-text {
    color: #999;
  }
}
.form-group input,
.form-group textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}
@media (prefers-color-scheme: dark) {
  .form-group input,
  .form-group textarea {
    background: #333;
    border-color: #555;
    color: #f6f6f6;
  }
}
.form-group textarea {
  resize: vertical;
  min-height: 150px;
}

/* Drop zone styles */
.drop-zone {
  border: 2px dashed #ccc;
  border-radius: 8px;
  padding: 24px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}
.drop-zone:hover {
  border-color: #24c8db;
  background: rgba(36, 200, 219, 0.05);
}
.drop-zone.dragging {
  border-color: #24c8db;
  background: rgba(36, 200, 219, 0.1);
  border-style: solid;
}
@media (prefers-color-scheme: dark) {
  .drop-zone {
    border-color: #555;
  }
  .drop-zone:hover {
    border-color: #24c8db;
    background: rgba(36, 200, 219, 0.1);
  }
  .drop-zone.dragging {
    background: rgba(36, 200, 219, 0.15);
  }
}
.file-input {
  display: none;
}
.drop-zone-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.drop-icon {
  font-size: 32px;
  color: #888;
  line-height: 1;
}
.drop-text {
  font-size: 13px;
  color: #666;
  line-height: 1.4;
}
@media (prefers-color-scheme: dark) {
  .drop-icon {
    color: #aaa;
  }
  .drop-text {
    color: #aaa;
  }
}

/* Image previews */
.image-previews {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 12px;
}
.image-preview {
  position: relative;
  width: 100px;
  height: 100px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #ddd;
}
@media (prefers-color-scheme: dark) {
  .image-preview {
    border-color: #555;
  }
}
.image-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.image-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.7);
  padding: 4px 6px;
  font-size: 10px;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.image-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.remove-image-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: rgba(220, 53, 69, 0.9);
  color: white;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.remove-image-btn:hover {
  background: #dc3545;
}

/* Processing text */
.processing-text {
  font-size: 12px;
  color: #24c8db;
  margin-top: 8px;
  margin-bottom: 0;
}

/* Warning text */
.warning-text {
  font-size: 12px;
  color: #f0ad4e;
  margin-top: 8px;
  margin-bottom: 0;
}

/* Error text */
.error-text {
  font-size: 12px;
  color: #dc3545;
  margin-top: 8px;
  margin-bottom: 0;
  white-space: pre-line;
}

.button-row {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 20px;
}
.primary-button {
  background: #24c8db;
  color: white;
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.primary-button:hover:not(:disabled) {
  background: #1ba8b8;
}
.primary-button:disabled {
  background: #999;
  cursor: not-allowed;
}
.secondary-button {
  background: #6c757d;
  color: white;
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.secondary-button:hover {
  background: #5a6268;
}
</style>
