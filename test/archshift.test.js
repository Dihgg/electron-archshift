import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyArchitecture } from '../src/archshift.js';

test('classifies Intel Mach-O binaries', () => {
  assert.equal(classifyArchitecture('Mach-O 64-bit executable x86_64'), 'x86_64');
});

test('classifies Apple Silicon Mach-O binaries', () => {
  assert.equal(classifyArchitecture('Mach-O 64-bit executable arm64'), 'arm64');
});

test('classifies universal binaries', () => {
  assert.equal(classifyArchitecture('Mach-O universal binary with 2 architectures: [x86_64] [arm64]'), 'universal');
});

test('classifies unrelated data as unknown', () => {
  assert.equal(classifyArchitecture('JSON text data'), 'unknown');
});
