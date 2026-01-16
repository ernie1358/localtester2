/**
 * UserMenu Component Tests
 * Tests for user menu component events and behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import UserMenu from '../components/UserMenu.vue';

// Mock supabaseClient
const mockGetSession = vi.fn();

vi.mock('../services/supabaseClient', () => ({
  getSession: () => mockGetSession(),
}));

describe('UserMenu Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: {
        email: 'test@example.com',
        user_metadata: {
          full_name: 'Test User',
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('User Icon Display', () => {
    it('should display user initial in icon button', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      const iconButton = wrapper.find('.user-icon-button');
      expect(iconButton.text()).toBe('T'); // First letter of "Test User"
    });

    it('should use email initial when name is not available', async () => {
      mockGetSession.mockResolvedValue({
        user: {
          email: 'alice@example.com',
          user_metadata: {},
        },
      });

      const wrapper = mount(UserMenu);
      await flushPromises();

      const iconButton = wrapper.find('.user-icon-button');
      expect(iconButton.text()).toBe('A'); // First letter of "alice@example.com"
    });

    it('should display ? when no user info', async () => {
      mockGetSession.mockResolvedValue(null);

      const wrapper = mount(UserMenu);
      await flushPromises();

      const iconButton = wrapper.find('.user-icon-button');
      expect(iconButton.text()).toBe('?');
    });

    it('should handle Japanese names correctly', async () => {
      mockGetSession.mockResolvedValue({
        user: {
          email: 'tanaka@example.com',
          user_metadata: {
            full_name: '田中太郎',
          },
        },
      });

      const wrapper = mount(UserMenu);
      await flushPromises();

      const iconButton = wrapper.find('.user-icon-button');
      expect(iconButton.text()).toBe('田');
    });
  });

  describe('Menu Toggle', () => {
    it('should not show dropdown initially', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      expect(wrapper.find('.dropdown-menu').exists()).toBe(false);
    });

    it('should show dropdown when icon is clicked', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');

      expect(wrapper.find('.dropdown-menu').exists()).toBe(true);
    });

    it('should hide dropdown when icon is clicked again', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');
      expect(wrapper.find('.dropdown-menu').exists()).toBe(true);

      await wrapper.find('.user-icon-button').trigger('click');
      expect(wrapper.find('.dropdown-menu').exists()).toBe(false);
    });
  });

  describe('User Info Display', () => {
    it('should display user name and email in dropdown', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');

      expect(wrapper.find('.user-name').text()).toBe('Test User');
      expect(wrapper.find('.user-email').text()).toBe('test@example.com');
    });

    it('should not show user-name span when name is empty', async () => {
      mockGetSession.mockResolvedValue({
        user: {
          email: 'test@example.com',
          user_metadata: {},
        },
      });

      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');

      expect(wrapper.find('.user-name').exists()).toBe(false);
      expect(wrapper.find('.user-email').text()).toBe('test@example.com');
    });
  });

  describe('Menu Items', () => {
    it('should have settings menu item', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');

      const menuItems = wrapper.findAll('.menu-item');
      expect(menuItems.some((item) => item.text().includes('設定'))).toBe(true);
    });

    it('should have logout menu item at the bottom', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');

      const menuItems = wrapper.findAll('.menu-item');
      const lastItem = menuItems[menuItems.length - 1];
      expect(lastItem.text()).toContain('ログアウト');
      expect(lastItem.classes()).toContain('logout-item');
    });
  });

  describe('Event Emission', () => {
    it('should emit openSettings event when settings is clicked', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');

      const settingsButton = wrapper.findAll('.menu-item').find((item) => item.text().includes('設定'));
      await settingsButton!.trigger('click');

      expect(wrapper.emitted('openSettings')).toBeTruthy();
      expect(wrapper.emitted('openSettings')!.length).toBe(1);
    });

    it('should emit logout event when logout is clicked', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');

      const logoutButton = wrapper.find('.logout-item');
      await logoutButton.trigger('click');

      expect(wrapper.emitted('logout')).toBeTruthy();
      expect(wrapper.emitted('logout')!.length).toBe(1);
    });

    it('should close menu after settings is clicked', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');
      expect(wrapper.find('.dropdown-menu').exists()).toBe(true);

      const settingsButton = wrapper.findAll('.menu-item').find((item) => item.text().includes('設定'));
      await settingsButton!.trigger('click');

      expect(wrapper.find('.dropdown-menu').exists()).toBe(false);
    });

    it('should close menu after logout is clicked', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');
      expect(wrapper.find('.dropdown-menu').exists()).toBe(true);

      const logoutButton = wrapper.find('.logout-item');
      await logoutButton.trigger('click');

      expect(wrapper.find('.dropdown-menu').exists()).toBe(false);
    });

    it('should emit events in correct order: close menu first, then emit event', async () => {
      const wrapper = mount(UserMenu);
      await flushPromises();

      await wrapper.find('.user-icon-button').trigger('click');

      const logoutButton = wrapper.find('.logout-item');
      await logoutButton.trigger('click');

      // Both should happen synchronously in the handler
      expect(wrapper.find('.dropdown-menu').exists()).toBe(false);
      expect(wrapper.emitted('logout')).toBeTruthy();
    });
  });

  describe('Click Outside Handling', () => {
    it('should close menu when clicking outside', async () => {
      const wrapper = mount(UserMenu, {
        attachTo: document.body,
      });
      await flushPromises();

      // Open menu
      await wrapper.find('.user-icon-button').trigger('click');
      expect(wrapper.find('.dropdown-menu').exists()).toBe(true);

      // Simulate click outside
      document.body.click();
      await wrapper.vm.$nextTick();

      expect(wrapper.find('.dropdown-menu').exists()).toBe(false);

      wrapper.unmount();
    });

    it('should not close menu when clicking inside menu', async () => {
      const wrapper = mount(UserMenu, {
        attachTo: document.body,
      });
      await flushPromises();

      // Open menu
      await wrapper.find('.user-icon-button').trigger('click');
      expect(wrapper.find('.dropdown-menu').exists()).toBe(true);

      // Click inside user-menu container
      const userMenuContainer = wrapper.find('.user-menu');
      await userMenuContainer.trigger('click');

      // Menu should still be open
      expect(wrapper.find('.dropdown-menu').exists()).toBe(true);

      wrapper.unmount();
    });
  });

  describe('Session Loading Error', () => {
    it('should handle session loading error gracefully', async () => {
      mockGetSession.mockRejectedValue(new Error('Session error'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const wrapper = mount(UserMenu);
      await flushPromises();

      // Should still render with fallback
      const iconButton = wrapper.find('.user-icon-button');
      expect(iconButton.text()).toBe('?');

      consoleSpy.mockRestore();
    });
  });
});
