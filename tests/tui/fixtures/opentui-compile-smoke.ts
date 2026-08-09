/**
 * P0 packaging spike fixture: the smallest real @opentui/core app.
 * Used by scripts/verify-opentui-compile.ts under `bun run` and as a
 * `bun build --compile` binary executed from an empty directory.
 * Prints OPENTUI_SMOKE_OK through the renderer and exits on "q".
 */
import { BoxRenderable, TextRenderable, createCliRenderer } from '@opentui/core';

const renderer = await createCliRenderer({ exitOnCtrlC: true });

const root = new BoxRenderable(renderer, {
  id: 'smoke-root',
  border: true,
  title: 'opentui smoke',
  width: '100%',
  height: '100%',
});
const label = new TextRenderable(renderer, {
  id: 'smoke-label',
  content: 'OPENTUI_SMOKE_OK press q to quit',
});
root.add(label);
renderer.root.add(root);

renderer.keyInput.on('keypress', (key: { name?: string }) => {
  if (key.name === 'q') {
    renderer.destroy();
    process.exit(0);
  }
});

renderer.requestRender();

const timeout = setTimeout(() => {
  renderer.destroy();
  process.exit(2);
}, 15_000);
timeout.unref();
