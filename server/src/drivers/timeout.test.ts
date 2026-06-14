import { describe, it, expect, vi } from 'vitest';
import { withQueryTimeout, timeoutError, timeoutLabel } from './timeout.js';
import { DriverError } from './interface.js';

describe('timeoutLabel', () => {
  it.each([
    [500, '500ms'],
    [1000, '1s'],
    [1500, '2s'],
    [30_000, '30s'],
    [60_000, '1m'],
    [300_000, '5m'],
    [90_000, '90s'], // not a whole number of minutes → seconds
  ])('renders %dms as %s', (ms, label) => {
    expect(timeoutLabel(ms)).toBe(label);
  });
});

describe('timeoutError', () => {
  it('is a transient DriverError carrying the timeout in its message', () => {
    const err = timeoutError(5000);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.errorClass).toBe('transient');
    expect(err.message).toBe('Query cancelled: exceeded the 5s timeout.');
  });
});

describe('withQueryTimeout', () => {
  it('returns the work result when it settles before the deadline', async () => {
    const onTimeout = vi.fn();
    const result = await withQueryTimeout(Promise.resolve('ok'), 1000, onTimeout);
    expect(result).toBe('ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('returns the work promise untouched when timeout is falsy or non-positive', async () => {
    const onTimeout = vi.fn();
    await expect(withQueryTimeout(Promise.resolve(1), 0, onTimeout)).resolves.toBe(1);
    await expect(withQueryTimeout(Promise.resolve(2), undefined, onTimeout)).resolves.toBe(2);
    await expect(withQueryTimeout(Promise.resolve(3), -5, onTimeout)).resolves.toBe(3);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('propagates the work rejection (not a timeout) when work fails first', async () => {
    const onTimeout = vi.fn();
    const boom = new Error('boom');
    await expect(withQueryTimeout(Promise.reject(boom), 1000, onTimeout)).rejects.toBe(boom);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('fires onTimeout and rejects with a transient DriverError when the deadline wins', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      // A promise that never settles on its own — only the deadline can resolve the race.
      const pending = new Promise<string>(() => {});
      const raced = withQueryTimeout(pending, 5000, onTimeout);
      const assertion = expect(raced).rejects.toMatchObject({
        errorClass: 'transient',
        message: 'Query cancelled: exceeded the 5s timeout.',
      });
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave the late work rejection unhandled after a timeout', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectWork!: (e: unknown) => void;
      const work = new Promise<string>((_, reject) => { rejectWork = reject; });
      const raced = withQueryTimeout(work, 1000, () => { /* would KILL here */ });
      const assertion = expect(raced).rejects.toBeInstanceOf(DriverError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      // The statement's error arrives only after the timeout already won the race.
      rejectWork(new Error('query interrupted'));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });
});
