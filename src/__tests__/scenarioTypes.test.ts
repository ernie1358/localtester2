/**
 * Scenario Type Tests
 * Tests for type mappings and helper functions
 */

import { describe, it, expect } from 'vitest';
import { mapTestResultStatusToScenarioStatus } from '../types/scenario';

describe('mapTestResultStatusToScenarioStatus', () => {
  it('should map success to completed', () => {
    expect(mapTestResultStatusToScenarioStatus('success')).toBe('completed');
  });

  it('should map stopped to stopped', () => {
    expect(mapTestResultStatusToScenarioStatus('stopped')).toBe('stopped');
  });

  it('should map failure to failed', () => {
    expect(mapTestResultStatusToScenarioStatus('failure')).toBe('failed');
  });

  it('should map timeout to failed', () => {
    expect(mapTestResultStatusToScenarioStatus('timeout')).toBe('failed');
  });

  it('should map error to failed', () => {
    expect(mapTestResultStatusToScenarioStatus('error')).toBe('failed');
  });
});
