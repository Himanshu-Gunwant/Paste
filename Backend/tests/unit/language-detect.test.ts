import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../../src/lib/language-detect.js';

describe('detectLanguage', () => {
  it('detects shebangs', () => {
    expect(detectLanguage('#!/bin/bash\necho hi')).toBe('bash');
    expect(detectLanguage('#!/usr/bin/env python3\nprint(1)')).toBe('python');
    expect(detectLanguage('#!/usr/bin/env node\nconsole.log(1)')).toBe('javascript');
  });

  it('detects explicit markers', () => {
    expect(detectLanguage('<?php echo 1;')).toBe('php');
    expect(detectLanguage('<!DOCTYPE html><html></html>')).toBe('html');
    expect(detectLanguage('package main\n\nfunc main() {}')).toBe('go');
  });

  it('scores keywords', () => {
    expect(detectLanguage('def greet(name):\n    return f"hi {name}"\n')).toBe('python');
    expect(detectLanguage('const x = () => console.log(x);\n')).toBe('javascript');
    expect(detectLanguage('#include <stdio.h>\nint main() { return 0; }')).toBe('cpp');
    expect(detectLanguage('SELECT id FROM users WHERE active = 1;')).toBe('sql');
  });

  it('detects JSON by parsing', () => {
    expect(detectLanguage('{"a": 1, "b": [2, 3]}')).toBe('json');
  });

  it('returns null for prose', () => {
    expect(detectLanguage('Just a plain note about nothing in particular.')).toBeNull();
  });
});
