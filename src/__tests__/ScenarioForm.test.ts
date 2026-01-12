/**
 * ScenarioForm Component Tests
 * Tests for hint image drag & drop, validation, and deletion
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ScenarioForm from '../components/ScenarioForm.vue';
import type { StepImage, FormImageData } from '../types';

// Helper to create a mock File
function createMockFile(name: string, size: number, type: string): File {
  const content = new Array(size).fill('a').join('');
  return new File([content], name, { type });
}

// Helper to create a mock DataTransfer
function createMockDataTransfer(files: File[]): DataTransfer {
  const dataTransfer = {
    files: {
      length: files.length,
      item: (index: number) => files[index],
      [Symbol.iterator]: function* () {
        for (let i = 0; i < files.length; i++) {
          yield files[i];
        }
      },
    } as unknown as FileList,
  };
  return dataTransfer as unknown as DataTransfer;
}

// Helper to create existing image data
function createMockStepImage(overrides: Partial<StepImage> = {}): StepImage {
  return {
    id: 'img-1',
    scenario_id: 'scenario-1',
    image_data: 'base64data',
    file_name: 'test.png',
    mime_type: 'image/png',
    order_index: 0,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ScenarioForm Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('should show modal when visible is true', () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      expect(wrapper.find('.modal-overlay').exists()).toBe(true);
    });

    it('should hide modal when visible is false', () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: false,
          scenario: null,
        },
      });

      expect(wrapper.find('.modal-overlay').exists()).toBe(false);
    });

    it('should show "新規テストステップ登録" title for new scenario', () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      expect(wrapper.find('h2').text()).toBe('新規テストステップ登録');
    });

    it('should show "テストステップ編集" title for existing scenario', () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: {
            id: '1',
            title: 'Test',
            description: 'Description',
            order_index: 0,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        },
      });

      expect(wrapper.find('h2').text()).toBe('テストステップ編集');
    });
  });

  describe('Save Button State', () => {
    it('should disable save button when description is empty', () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      const saveButton = wrapper.find('.primary-button');
      expect((saveButton.element as HTMLButtonElement).disabled).toBe(true);
    });

    it('should enable save button when description has content', async () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      await wrapper.find('#description-input').setValue('Some description');

      const saveButton = wrapper.find('.primary-button');
      expect((saveButton.element as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('Image Drop Zone', () => {
    it('should have drop zone element', () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      expect(wrapper.find('.drop-zone').exists()).toBe(true);
    });

    it('should show dragging state when dragging over', async () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      const dropZone = wrapper.find('.drop-zone');
      await dropZone.trigger('dragover');

      expect(dropZone.classes()).toContain('dragging');
    });

    it('should remove dragging state when drag leaves', async () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      const dropZone = wrapper.find('.drop-zone');
      await dropZone.trigger('dragover');
      await dropZone.trigger('dragleave');

      expect(dropZone.classes()).not.toContain('dragging');
    });
  });

  describe('Image Validation', () => {
    it('should show error for unsupported file type', async () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      const mockFile = createMockFile('test.txt', 100, 'text/plain');
      const dropZone = wrapper.find('.drop-zone');

      // Trigger drop with mock file
      await dropZone.trigger('drop', {
        dataTransfer: createMockDataTransfer([mockFile]),
      });
      await flushPromises();

      const errorText = wrapper.find('.error-text');
      expect(errorText.exists()).toBe(true);
      expect(errorText.text()).toContain('サポートされていない形式');
    });

    it('should show warning for file exceeding 5MB but still allow save', async () => {
      // Mock FileReader to be synchronous for testing
      const originalFileReader = globalThis.FileReader;
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        onerror: (() => void) | null = null;
        result: string | null = null;

        readAsDataURL(_file: File) {
          this.result = 'data:image/png;base64,testdata';
          Promise.resolve().then(() => {
            if (this.onload) {
              this.onload({ target: this } as unknown as ProgressEvent<FileReader>);
            }
          });
        }
      }
      globalThis.FileReader = MockFileReader as unknown as typeof FileReader;

      try {
        const wrapper = mount(ScenarioForm, {
          props: {
            visible: true,
            scenario: null,
          },
        });

        // Create a file larger than 5MB (5 * 1024 * 1024 bytes)
        const largeFile = createMockFile('large.png', 6 * 1024 * 1024, 'image/png');
        const dropZone = wrapper.find('.drop-zone');

        await dropZone.trigger('drop', {
          dataTransfer: createMockDataTransfer([largeFile]),
        });
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await flushPromises();

        // Should show warning (not error) - file is still added
        const warningText = wrapper.find('.warning-text');
        expect(warningText.exists()).toBe(true);
        expect(warningText.text()).toContain('送信時に除外される可能性');

        // Image should still be added (save is unlimited)
        const previews = wrapper.findAll('.image-preview');
        expect(previews.length).toBe(1);
      } finally {
        globalThis.FileReader = originalFileReader;
      }
    });
  });

  describe('Image Count Limit - Save is Unlimited', () => {
    it('should allow adding more than 20 images but show warning', async () => {
      // Mock FileReader to be synchronous for testing
      const originalFileReader = globalThis.FileReader;
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        onerror: (() => void) | null = null;
        result: string | null = null;

        readAsDataURL(_file: File) {
          this.result = 'data:image/png;base64,testdata';
          Promise.resolve().then(() => {
            if (this.onload) {
              this.onload({ target: this } as unknown as ProgressEvent<FileReader>);
            }
          });
        }
      }
      globalThis.FileReader = MockFileReader as unknown as typeof FileReader;

      try {
        const existingImages: StepImage[] = Array(20)
          .fill(null)
          .map((_, i) =>
            createMockStepImage({
              id: `img-${i}`,
              file_name: `image${i}.png`,
            })
          );

        const wrapper = mount(ScenarioForm, {
          props: {
            visible: true,
            scenario: null,
            existingImages,
          },
        });

        await flushPromises();

        const mockFile = createMockFile('new.png', 100, 'image/png');
        const dropZone = wrapper.find('.drop-zone');

        await dropZone.trigger('drop', {
          dataTransfer: createMockDataTransfer([mockFile]),
        });
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await flushPromises();

        // Should show warning about API limit, not error
        const warningText = wrapper.find('.warning-text');
        expect(warningText.exists()).toBe(true);
        expect(warningText.text()).toContain('API制限');
        expect(warningText.text()).toContain('20枚');

        // Image should still be added (save is unlimited, API limit at send time)
        const previews = wrapper.findAll('.image-preview');
        expect(previews.length).toBe(21);
      } finally {
        globalThis.FileReader = originalFileReader;
      }
    });

    it('should add all images without warning when under limit', async () => {
      // Mock FileReader to be synchronous for testing
      const originalFileReader = globalThis.FileReader;
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        onerror: (() => void) | null = null;
        result: string | null = null;

        readAsDataURL(_file: File) {
          this.result = 'data:image/png;base64,testdata';
          Promise.resolve().then(() => {
            if (this.onload) {
              this.onload({ target: this } as unknown as ProgressEvent<FileReader>);
            }
          });
        }
      }
      globalThis.FileReader = MockFileReader as unknown as typeof FileReader;

      try {
        // With MAX_IMAGE_COUNT=20, start with 18 existing images
        const existingImages: StepImage[] = Array(18)
          .fill(null)
          .map((_, i) =>
            createMockStepImage({
              id: `img-${i}`,
              file_name: `image${i}.png`,
            })
          );

        const wrapper = mount(ScenarioForm, {
          props: {
            visible: true,
            scenario: null,
            existingImages,
          },
        });

        await flushPromises();

        // Add 2 valid images (still within 20 limit)
        const mockFiles = Array(2)
          .fill(null)
          .map((_, i) => createMockFile(`new${i}.png`, 100, 'image/png'));

        const dropZone = wrapper.find('.drop-zone');

        await dropZone.trigger('drop', {
          dataTransfer: createMockDataTransfer(mockFiles),
        });

        // Wait for all async processing
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await flushPromises();

        // No warning when under limit
        const warningText = wrapper.find('.warning-text');
        expect(warningText.exists()).toBe(false);

        // All images added
        const previews = wrapper.findAll('.image-preview');
        expect(previews.length).toBe(20);
      } finally {
        globalThis.FileReader = originalFileReader;
      }
    });
  });

  describe('Existing Images', () => {
    it('should display existing images on load', async () => {
      const existingImages: StepImage[] = [
        createMockStepImage({ id: 'img-1', file_name: 'test1.png' }),
        createMockStepImage({ id: 'img-2', file_name: 'test2.png' }),
      ];

      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
          existingImages,
        },
      });

      await flushPromises();

      const previews = wrapper.findAll('.image-preview');
      expect(previews.length).toBe(2);
    });

    it('should have remove button for each image', async () => {
      const existingImages: StepImage[] = [
        createMockStepImage({ id: 'img-1', file_name: 'test1.png' }),
      ];

      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
          existingImages,
        },
      });

      await flushPromises();

      const removeButton = wrapper.find('.remove-image-btn');
      expect(removeButton.exists()).toBe(true);
    });

    it('should remove image from display when delete button is clicked', async () => {
      const existingImages: StepImage[] = [
        createMockStepImage({ id: 'img-1', file_name: 'test1.png' }),
      ];

      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
          existingImages,
        },
      });

      await flushPromises();
      expect(wrapper.findAll('.image-preview').length).toBe(1);

      await wrapper.find('.remove-image-btn').trigger('click');
      await flushPromises();

      expect(wrapper.findAll('.image-preview').length).toBe(0);
    });
  });

  describe('Save Emit', () => {
    it('should emit save event with form data including images', async () => {
      const existingImages: StepImage[] = [
        createMockStepImage({ id: 'img-1', file_name: 'test1.png' }),
      ];

      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
          existingImages,
        },
      });

      await wrapper.find('#title-input').setValue('Test Title');
      await wrapper.find('#description-input').setValue('Test Description');

      await wrapper.find('.primary-button').trigger('click');

      const emitted = wrapper.emitted('save');
      expect(emitted).toBeTruthy();
      expect(emitted![0][0]).toBe('Test Title');
      expect(emitted![0][1]).toBe('Test Description');
      expect(Array.isArray(emitted![0][2])).toBe(true);
    });

    it('should mark deleted images with markedForDeletion flag', async () => {
      const existingImages: StepImage[] = [
        createMockStepImage({ id: 'img-1', file_name: 'test1.png' }),
      ];

      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
          existingImages,
        },
      });

      await flushPromises();

      // Delete the image
      await wrapper.find('.remove-image-btn').trigger('click');

      // Fill required field and save
      await wrapper.find('#description-input').setValue('Test Description');
      await wrapper.find('.primary-button').trigger('click');

      const emitted = wrapper.emitted('save');
      expect(emitted).toBeTruthy();
      const images = emitted![0][2] as FormImageData[];
      expect(images.length).toBe(1);
      expect(images[0].markedForDeletion).toBe(true);
    });
  });

  describe('Cancel', () => {
    it('should emit cancel event when cancel button is clicked', async () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      await wrapper.find('.secondary-button').trigger('click');

      expect(wrapper.emitted('cancel')).toBeTruthy();
    });

    it('should emit cancel event when clicking overlay', async () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      await wrapper.find('.modal-overlay').trigger('click');

      expect(wrapper.emitted('cancel')).toBeTruthy();
    });
  });

  describe('Processing State', () => {
    it('should have isProcessingImages ref', () => {
      const wrapper = mount(ScenarioForm, {
        props: {
          visible: true,
          scenario: null,
        },
      });

      // Access component instance to verify ref exists
      const vm = wrapper.vm as unknown as { isProcessingImages: { value: boolean } };
      expect(typeof vm.isProcessingImages).toBe('boolean');
    });
  });

  describe('Total Size Limit - Save is Unlimited', () => {
    it('should allow adding images exceeding 11MB total but show warning', async () => {
      // Mock FileReader to return a large base64 string (simulating a 3MB file)
      const originalFileReader = globalThis.FileReader;
      // 3MB in base64 format (3MB * 1.33 ≈ 4MB base64 string)
      const largeBase64 = 'a'.repeat(Math.floor((3 * 1024 * 1024) / 0.75));

      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        onerror: (() => void) | null = null;
        result: string | null = null;

        readAsDataURL(_file: File) {
          // Return a large base64 to simulate a 3MB file
          this.result = `data:image/png;base64,${largeBase64}`;
          Promise.resolve().then(() => {
            if (this.onload) {
              this.onload({ target: this } as unknown as ProgressEvent<FileReader>);
            }
          });
        }
      }
      globalThis.FileReader = MockFileReader as unknown as typeof FileReader;

      try {
        // Start with existing images that are close to the 11MB limit
        // Use 3 images of ~3MB each (9MB total)
        const existingImages: StepImage[] = Array(3)
          .fill(null)
          .map((_, i) =>
            createMockStepImage({
              id: `img-${i}`,
              file_name: `large${i}.png`,
              // 3MB worth of base64 data (~4MB in base64)
              image_data: largeBase64,
            })
          );

        const wrapper = mount(ScenarioForm, {
          props: {
            visible: true,
            scenario: null,
            existingImages,
          },
        });

        await flushPromises();

        // Try to add a file that would bring total to 12MB (exceeds 11MB limit)
        const largeFile = createMockFile('extra.png', 3 * 1024 * 1024, 'image/png');
        const dropZone = wrapper.find('.drop-zone');

        await dropZone.trigger('drop', {
          dataTransfer: createMockDataTransfer([largeFile]),
        });
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await flushPromises();

        // Should show warning about API limit being exceeded
        const warningText = wrapper.find('.warning-text');
        expect(warningText.exists()).toBe(true);
        expect(warningText.text()).toContain('API制限');
        expect(warningText.text()).toContain('11MB');

        // Image should still be added (save is unlimited, API limit at send time)
        const previews = wrapper.findAll('.image-preview');
        expect(previews.length).toBe(4);
      } finally {
        globalThis.FileReader = originalFileReader;
      }
    });
  });

  describe('Invalid Files Mixed with Valid Files - Save is Unlimited', () => {
    it('should skip invalid MIME types but add all valid files', async () => {
      // Mock FileReader to be synchronous for testing
      const originalFileReader = globalThis.FileReader;
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        onerror: (() => void) | null = null;
        result: string | null = null;

        readAsDataURL(_file: File) {
          this.result = 'data:image/png;base64,testdata';
          Promise.resolve().then(() => {
            if (this.onload) {
              this.onload({ target: this } as unknown as ProgressEvent<FileReader>);
            }
          });
        }
      }
      globalThis.FileReader = MockFileReader as unknown as typeof FileReader;

      try {
        // Start with 18 existing images
        const existingImages: StepImage[] = Array(18)
          .fill(null)
          .map((_, i) =>
            createMockStepImage({
              id: `img-${i}`,
              file_name: `image${i}.png`,
            })
          );

        const wrapper = mount(ScenarioForm, {
          props: {
            visible: true,
            scenario: null,
            existingImages,
          },
        });

        await flushPromises();

        // Drop 5 files: 2 invalid (text files), then 3 valid
        // Save is unlimited, so all 3 valid files should be added (total: 21)
        const mockFiles = [
          createMockFile('invalid1.txt', 100, 'text/plain'),
          createMockFile('invalid2.txt', 100, 'text/plain'),
          createMockFile('valid1.png', 100, 'image/png'),
          createMockFile('valid2.png', 100, 'image/png'),
          createMockFile('valid3.png', 100, 'image/png'),
        ];

        const dropZone = wrapper.find('.drop-zone');

        await dropZone.trigger('drop', {
          dataTransfer: createMockDataTransfer(mockFiles),
        });

        // Wait for all async processing
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await flushPromises();

        // Should have added all 3 valid images (save is unlimited)
        const previews = wrapper.findAll('.image-preview');
        expect(previews.length).toBe(21); // 18 existing + 3 new valid

        // Should show error for invalid files
        const errorText = wrapper.find('.error-text');
        expect(errorText.exists()).toBe(true);
        expect(errorText.text()).toContain('サポートされていない形式');

        // Should show warning about API limit being exceeded
        const warningText = wrapper.find('.warning-text');
        expect(warningText.exists()).toBe(true);
        expect(warningText.text()).toContain('API制限');
      } finally {
        globalThis.FileReader = originalFileReader;
      }
    });

    it('should add all valid files when no limit warning needed', async () => {
      // Mock FileReader to be synchronous for testing
      const originalFileReader = globalThis.FileReader;
      class MockFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        onerror: (() => void) | null = null;
        result: string | null = null;

        readAsDataURL(_file: File) {
          this.result = 'data:image/png;base64,testdata';
          Promise.resolve().then(() => {
            if (this.onload) {
              this.onload({ target: this } as unknown as ProgressEvent<FileReader>);
            }
          });
        }
      }
      globalThis.FileReader = MockFileReader as unknown as typeof FileReader;

      try {
        const wrapper = mount(ScenarioForm, {
          props: {
            visible: true,
            scenario: null,
            existingImages: [],
          },
        });

        await flushPromises();

        // Drop 3 files: 1 invalid, 2 valid
        const mockFiles = [
          createMockFile('invalid.txt', 100, 'text/plain'),
          createMockFile('valid1.png', 100, 'image/png'),
          createMockFile('valid2.png', 100, 'image/png'),
        ];

        const dropZone = wrapper.find('.drop-zone');

        await dropZone.trigger('drop', {
          dataTransfer: createMockDataTransfer(mockFiles),
        });

        // Wait for all async processing
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await flushPromises();

        // Should have added 2 valid images
        const previews = wrapper.findAll('.image-preview');
        expect(previews.length).toBe(2);

        // Should show error for invalid file
        const errorText = wrapper.find('.error-text');
        expect(errorText.exists()).toBe(true);
        expect(errorText.text()).toContain('サポートされていない形式');

        // Should NOT show warning (under API limit)
        const warningText = wrapper.find('.warning-text');
        expect(warningText.exists()).toBe(false);
      } finally {
        globalThis.FileReader = originalFileReader;
      }
    });
  });
});
