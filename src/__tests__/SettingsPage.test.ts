/**
 * SettingsPage Component Tests
 * Tests for settings page URL validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SettingsPage from '../pages/SettingsPage.vue';

// Mock Tauri event API
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Mock settingsService
const mockGetSettings = vi.fn();
const mockSaveSettings = vi.fn();

vi.mock('../services/settingsService', () => ({
  getSettings: () => mockGetSettings(),
  saveSettings: (settings: unknown) => mockSaveSettings(settings),
}));

describe('SettingsPage Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({ failureWebhookUrl: '' });
    mockSaveSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('should render settings page', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      expect(wrapper.find('h1').text()).toBe('設定');
    });

    it('should load existing settings on mount', async () => {
      mockGetSettings.mockResolvedValue({ failureWebhookUrl: 'https://example.com/webhook' });

      const wrapper = mount(SettingsPage);
      await flushPromises();

      const input = wrapper.find('#webhook-url');
      expect((input.element as HTMLInputElement).value).toBe('https://example.com/webhook');
    });

    it('should show loading state initially', () => {
      const wrapper = mount(SettingsPage);
      expect(wrapper.find('.loading').exists()).toBe(true);
    });

    it('should hide loading state after settings are loaded', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      expect(wrapper.find('.loading').exists()).toBe(false);
    });
  });

  describe('URL Validation', () => {
    it('should allow saving empty URL', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).toHaveBeenCalledWith({ failureWebhookUrl: '' });
      expect(wrapper.find('.error-box').exists()).toBe(false);
    });

    it('should allow saving valid https URL', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('https://example.com/webhook');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).toHaveBeenCalledWith({ failureWebhookUrl: 'https://example.com/webhook' });
      expect(wrapper.find('.error-box').exists()).toBe(false);
    });

    it('should allow saving valid http URL', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('http://localhost:8080/webhook');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).toHaveBeenCalledWith({ failureWebhookUrl: 'http://localhost:8080/webhook' });
      expect(wrapper.find('.error-box').exists()).toBe(false);
    });

    it('should reject ftp:// URL', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('ftp://example.com/file');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).not.toHaveBeenCalled();
      expect(wrapper.find('.error-box').exists()).toBe(true);
      expect(wrapper.find('.error-box').text()).toContain('http://またはhttps://');
    });

    it('should reject file:// URL', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('file:///etc/passwd');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).not.toHaveBeenCalled();
      expect(wrapper.find('.error-box').exists()).toBe(true);
      expect(wrapper.find('.error-box').text()).toContain('http://またはhttps://');
    });

    it('should reject javascript: URL', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('javascript:alert(1)');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).not.toHaveBeenCalled();
      expect(wrapper.find('.error-box').exists()).toBe(true);
    });

    it('should reject invalid URL format', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('not-a-valid-url');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).not.toHaveBeenCalled();
      expect(wrapper.find('.error-box').exists()).toBe(true);
      expect(wrapper.find('.error-box').text()).toContain('有効なURL');
    });

    it('should trim whitespace from URL before validation', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('  https://example.com/webhook  ');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).toHaveBeenCalledWith({ failureWebhookUrl: 'https://example.com/webhook' });
    });

    it('should allow saving whitespace-only as empty string', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('   ');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(mockSaveSettings).toHaveBeenCalledWith({ failureWebhookUrl: '' });
    });
  });

  describe('Save Feedback', () => {
    it('should show success message on successful save', async () => {
      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('https://example.com/webhook');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(wrapper.find('.success-box').exists()).toBe(true);
      expect(wrapper.find('.success-box').text()).toContain('保存しました');
    });

    it('should show error message on save failure', async () => {
      mockSaveSettings.mockRejectedValue(new Error('Database error'));

      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('https://example.com/webhook');
      await wrapper.find('.primary-button').trigger('click');
      await flushPromises();

      expect(wrapper.find('.error-box').exists()).toBe(true);
      expect(wrapper.find('.error-box').text()).toContain('保存に失敗');
    });

    it('should disable save button while saving', async () => {
      let resolvePromise: (value?: unknown) => void;
      mockSaveSettings.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          })
      );

      const wrapper = mount(SettingsPage);
      await flushPromises();

      await wrapper.find('#webhook-url').setValue('https://example.com/webhook');
      wrapper.find('.primary-button').trigger('click');

      // Wait for Vue to update
      await wrapper.vm.$nextTick();

      const button = wrapper.find('.primary-button');
      expect((button.element as HTMLButtonElement).disabled).toBe(true);
      expect(button.text()).toContain('保存中');

      // Resolve and check button is re-enabled
      resolvePromise!();
      await flushPromises();
      expect((button.element as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('Load Failure', () => {
    it('should show error when settings fail to load', async () => {
      mockGetSettings.mockRejectedValue(new Error('Database error'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const wrapper = mount(SettingsPage);
      await flushPromises();

      expect(wrapper.find('.error-box').exists()).toBe(true);
      expect(wrapper.find('.error-box').text()).toContain('読み込みに失敗');

      consoleSpy.mockRestore();
    });
  });
});
