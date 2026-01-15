/**
 * StopButton Component Tests
 *
 * Vue Test Utils tests for the StopButton component.
 * These tests verify the actual component behavior including:
 * - Button rendering and disabled state
 * - Label changes based on isStopping prop
 * - Click event emission
 * - CSS class application
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import StopButton from '../components/StopButton.vue';

describe('StopButton Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial Rendering', () => {
    it('should render with default label when not stopping', () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect(button.exists()).toBe(true);
      expect(button.text()).toBe('停止 (Shift+Esc)');
    });

    it('should render with stopping label when isStopping is true', () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: true,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect(button.text()).toBe('停止中...');
    });
  });

  describe('Disabled State', () => {
    it('should be enabled when not stopping', () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect((button.element as HTMLButtonElement).disabled).toBe(false);
    });

    it('should be disabled when stopping', () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: true,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect((button.element as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('CSS Classes', () => {
    it('should have danger-button class always', () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect(button.classes()).toContain('danger-button');
    });

    it('should not have stopping class when not stopping', () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect(button.classes()).not.toContain('stopping');
    });

    it('should have stopping class when isStopping is true', () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: true,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect(button.classes()).toContain('stopping');
    });
  });

  describe('Click Events', () => {
    it('should emit stop event when clicked and not stopping', async () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      await button.trigger('click');

      expect(wrapper.emitted('stop')).toBeTruthy();
      expect(wrapper.emitted('stop')?.length).toBe(1);
    });

    it('should not emit stop event when clicked while stopping', async () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: true,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      // Even though button is disabled, we test the internal logic
      await button.trigger('click');

      expect(wrapper.emitted('stop')).toBeFalsy();
    });
  });

  describe('State Transitions', () => {
    it('should update label when isStopping changes from false to true', async () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect(button.text()).toBe('停止 (Shift+Esc)');

      await wrapper.setProps({ isStopping: true });

      expect(button.text()).toBe('停止中...');
    });

    it('should update disabled state when isStopping changes', async () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect((button.element as HTMLButtonElement).disabled).toBe(false);

      await wrapper.setProps({ isStopping: true });

      expect((button.element as HTMLButtonElement).disabled).toBe(true);
    });

    it('should update CSS class when isStopping changes', async () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect(button.classes()).not.toContain('stopping');

      await wrapper.setProps({ isStopping: true });

      expect(button.classes()).toContain('stopping');
    });

    it('should return to normal state when isStopping changes back to false', async () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: true,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');
      expect(button.text()).toBe('停止中...');
      expect((button.element as HTMLButtonElement).disabled).toBe(true);
      expect(button.classes()).toContain('stopping');

      await wrapper.setProps({ isStopping: false });

      expect(button.text()).toBe('停止 (Shift+Esc)');
      expect((button.element as HTMLButtonElement).disabled).toBe(false);
      expect(button.classes()).not.toContain('stopping');
    });
  });

  describe('Double-click Prevention', () => {
    it('should only emit one stop event on rapid clicks', async () => {
      const wrapper = mount(StopButton, {
        props: {
          isStopping: false,
        },
      });

      const button = wrapper.find('[data-testid="stop-button"]');

      // First click emits the event
      await button.trigger('click');
      expect(wrapper.emitted('stop')?.length).toBe(1);

      // Simulate parent setting isStopping to true
      await wrapper.setProps({ isStopping: true });

      // Second click should not emit (button is now stopping)
      await button.trigger('click');
      expect(wrapper.emitted('stop')?.length).toBe(1); // Still 1
    });
  });
});
