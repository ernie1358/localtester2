/**
 * ScenarioList Component Tests
 * Tests for scenario selection, ordering, and UI behavior
 */

import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import ScenarioList from '../components/ScenarioList.vue';
import type { StoredScenario } from '../types';

// Mock vue-draggable-plus
vi.mock('vue-draggable-plus', () => ({
  VueDraggable: defineComponent({
    name: 'VueDraggable',
    props: ['modelValue', 'handle', 'disabled', 'itemKey'],
    emits: ['update:modelValue', 'end'],
    setup(_props, { slots }) {
      return () => {
        // VueDraggable uses default slot, not item slot
        return h('div', { class: 'mock-draggable scenario-rows' },
          slots.default?.()
        );
      };
    },
  }),
}));

const createMockScenario = (overrides: Partial<StoredScenario> = {}): StoredScenario => ({
  id: 'test-id',
  title: 'Test Scenario',
  description: 'Test Description',
  order_index: 0,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('ScenarioList Component', () => {
  describe('Empty State', () => {
    it('should show empty message when no scenarios', () => {
      const wrapper = mount(ScenarioList, {
        props: {
          scenarios: [],
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      expect(wrapper.find('.empty-message').exists()).toBe(true);
      expect(wrapper.text()).toContain('テストステップがありません');
    });
  });

  describe('Scenario List', () => {
    it('should render scenarios in order', () => {
      const scenarios = [
        createMockScenario({ id: '1', title: 'First', order_index: 0 }),
        createMockScenario({ id: '2', title: 'Second', order_index: 1 }),
        createMockScenario({ id: '3', title: 'Third', order_index: 2 }),
      ];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      const titles = wrapper.findAll('.scenario-title');
      expect(titles[0].text()).toBe('First');
      expect(titles[1].text()).toBe('Second');
      expect(titles[2].text()).toBe('Third');
    });

    it('should show order numbers starting from 1', () => {
      const scenarios = [
        createMockScenario({ id: '1', order_index: 0 }),
        createMockScenario({ id: '2', order_index: 1 }),
      ];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      const orderNumbers = wrapper.findAll('.order-number');
      expect(orderNumbers[0].text()).toBe('1');
      expect(orderNumbers[1].text()).toBe('2');
    });

    it('should truncate long descriptions with ellipsis', () => {
      const longDescription = 'This is a very long description that exceeds fifty characters and should be truncated';
      const scenarios = [createMockScenario({ description: longDescription })];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      const descEl = wrapper.find('.scenario-description');
      expect(descEl.text()).toContain('...');
      expect(descEl.text().length).toBeLessThan(longDescription.length);
    });
  });

  describe('Checkbox Position', () => {
    it('should have checkbox as the first element in scenario row (leftmost)', () => {
      const scenarios = [createMockScenario()];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      const row = wrapper.find('.scenario-row');
      const children = row.element.children;

      // First child should be the checkbox
      expect(children[0].tagName.toLowerCase()).toBe('input');
      expect(children[0].getAttribute('type')).toBe('checkbox');
    });

    it('should have drag handle as the last element in scenario row (rightmost)', () => {
      const scenarios = [createMockScenario()];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      const row = wrapper.find('.scenario-row');
      const children = row.element.children;
      const lastChild = children[children.length - 1];

      // Last child should be the drag handle
      expect(lastChild.classList.contains('drag-handle')).toBe(true);
    });
  });

  describe('Selection', () => {
    it('should emit update:selectedIds when checkbox is clicked', async () => {
      const scenarios = [createMockScenario({ id: 'test-1' })];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      const checkbox = wrapper.find('input[type="checkbox"].scenario-checkbox');
      await checkbox.setValue(true);

      const emitted = wrapper.emitted('update:selectedIds');
      expect(emitted).toBeTruthy();
      expect(emitted![0][0]).toEqual(new Set(['test-1']));
    });

    it('should show checkbox as checked when scenario is selected', () => {
      const scenarios = [createMockScenario({ id: 'test-1' })];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set(['test-1']),
          isRunning: false,
        },
      });

      const checkbox = wrapper.find('input[type="checkbox"].scenario-checkbox');
      expect((checkbox.element as HTMLInputElement).checked).toBe(true);
    });

    it('should select all when "select all" checkbox is clicked', async () => {
      const scenarios = [
        createMockScenario({ id: '1' }),
        createMockScenario({ id: '2' }),
        createMockScenario({ id: '3' }),
      ];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      const selectAllCheckbox = wrapper.find('.list-header input[type="checkbox"]');
      await selectAllCheckbox.setValue(true);

      const emitted = wrapper.emitted('update:selectedIds');
      expect(emitted).toBeTruthy();
      expect(emitted![0][0]).toEqual(new Set(['1', '2', '3']));
    });

    it('should deselect all when "select all" checkbox is unchecked', async () => {
      const scenarios = [
        createMockScenario({ id: '1' }),
        createMockScenario({ id: '2' }),
      ];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set(['1', '2']),
          isRunning: false,
        },
      });

      const selectAllCheckbox = wrapper.find('.list-header input[type="checkbox"]');
      await selectAllCheckbox.setValue(false);

      const emitted = wrapper.emitted('update:selectedIds');
      expect(emitted).toBeTruthy();
      expect(emitted![0][0]).toEqual(new Set());
    });
  });

  describe('getSelectedIdsInOrder', () => {
    it('should return selected IDs in display order', () => {
      const scenarios = [
        createMockScenario({ id: '1', order_index: 0 }),
        createMockScenario({ id: '2', order_index: 1 }),
        createMockScenario({ id: '3', order_index: 2 }),
      ];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set(['3', '1']), // Selected in different order
          isRunning: false,
        },
      });

      const orderedIds = wrapper.vm.getSelectedIdsInOrder();

      // Should return in display order: 1, 3 (not 3, 1)
      expect(orderedIds).toEqual(['1', '3']);
    });

    it('should return empty array when nothing selected', () => {
      const scenarios = [createMockScenario({ id: '1' })];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      expect(wrapper.vm.getSelectedIdsInOrder()).toEqual([]);
    });
  });

  describe('Running State', () => {
    it('should disable checkboxes when running', () => {
      const scenarios = [createMockScenario()];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: true,
        },
      });

      const checkbox = wrapper.find('input[type="checkbox"].scenario-checkbox');
      expect((checkbox.element as HTMLInputElement).disabled).toBe(true);
    });

    it('should disable edit and delete buttons when running', () => {
      const scenarios = [createMockScenario()];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: true,
        },
      });

      const editButton = wrapper.find('.edit-button');
      const deleteButton = wrapper.find('.delete-button');

      expect((editButton.element as HTMLButtonElement).disabled).toBe(true);
      expect((deleteButton.element as HTMLButtonElement).disabled).toBe(true);
    });

    it('should disable drag handle when running', () => {
      const scenarios = [createMockScenario()];

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios,
          selectedIds: new Set<string>(),
          isRunning: true,
        },
      });

      const dragHandle = wrapper.find('.drag-handle');
      expect(dragHandle.classes()).toContain('disabled');
    });
  });

  describe('Edit and Delete', () => {
    it('should emit edit event when edit button is clicked', async () => {
      const scenario = createMockScenario({ id: 'test-1' });

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios: [scenario],
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      await wrapper.find('.edit-button').trigger('click');

      const emitted = wrapper.emitted('edit');
      expect(emitted).toBeTruthy();
      expect(emitted![0][0]).toEqual(scenario);
    });

    it('should emit delete event when delete button is clicked', async () => {
      const scenario = createMockScenario({ id: 'test-1' });

      const wrapper = mount(ScenarioList, {
        props: {
          scenarios: [scenario],
          selectedIds: new Set<string>(),
          isRunning: false,
        },
      });

      await wrapper.find('.delete-button').trigger('click');

      const emitted = wrapper.emitted('delete');
      expect(emitted).toBeTruthy();
      expect(emitted![0][0]).toEqual(scenario);
    });
  });
});
