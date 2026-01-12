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

    it('should show error for file exceeding 5MB', async () => {
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

      const errorText = wrapper.find('.error-text');
      expect(errorText.exists()).toBe(true);
      expect(errorText.text()).toContain('5MBを超えています');
    });
  });

  describe('Image Count Limit', () => {
    it('should show error when trying to add more than 10 images', async () => {
      const existingImages: StepImage[] = Array(10)
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

      const errorText = wrapper.find('.error-text');
      expect(errorText.exists()).toBe(true);
      expect(errorText.text()).toContain('最大10枚まで');
    });

    it('should show warning when partially adding images due to limit', async () => {
      const existingImages: StepImage[] = Array(8)
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

      // Try to add 5 images when only 2 slots are available
      const mockFiles = Array(5)
        .fill(null)
        .map((_, i) => createMockFile(`new${i}.png`, 100, 'image/png'));

      const dropZone = wrapper.find('.drop-zone');

      await dropZone.trigger('drop', {
        dataTransfer: createMockDataTransfer(mockFiles),
      });
      await flushPromises();

      const warningText = wrapper.find('.warning-text');
      expect(warningText.exists()).toBe(true);
      expect(warningText.text()).toContain('5枚中2枚のみ追加可能');
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
});
