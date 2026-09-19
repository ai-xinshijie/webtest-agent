// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createElement } from 'react';

vi.mock('../src/App.js', () => ({
  default: () => createElement('div', null, 'WebTestAgent 入口'),
}));

it('渲染 Web GUI 进程入口', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await import('../src/main.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.getElementById('root')?.textContent).toContain('WebTestAgent');
});
