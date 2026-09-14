import { createRoot, type Root } from 'react-dom/client';
import { StateApp } from './App';
import { RpStateMachine, type TavernContext } from './runtime';

declare global {
  interface Window {
    SillyTavern?: { getContext(): TavernContext };
    rpStateMachineGenerationInterceptor?: (...args: unknown[]) => Promise<void>;
    rpStateMachineDispose?: () => void;
  }
}
const lifecycle: {
  root?: Root;
  runtime?: RpStateMachine;
  readyContext?: TavernContext;
  readyType?: string;
} = {};
const context = () => {
  if (!window.SillyTavern) throw new Error('SillyTavern context unavailable');
  return window.SillyTavern.getContext();
};
function mount() {
  if (lifecycle.root || !window.SillyTavern) return;
  const host = document.createElement('div');
  host.id = 'rp-state-machine-root';
  document.body.append(host);
  lifecycle.runtime = new RpStateMachine(context, () =>
    lifecycle.root?.render(
      <StateApp runtime={lifecycle.runtime!} getContext={context} />,
    ),
  );
  lifecycle.runtime.start();
  lifecycle.root = createRoot(host);
  lifecycle.root.render(
    <StateApp runtime={lifecycle.runtime} getContext={context} />,
  );
}
window.rpStateMachineGenerationInterceptor = async (...args) =>
  lifecycle.runtime?.inject(args[3]);
window.rpStateMachineDispose = () => {
  if (lifecycle.readyContext && lifecycle.readyType) {
    if (lifecycle.readyContext.eventSource.off)
      lifecycle.readyContext.eventSource.off(lifecycle.readyType, mount);
    else
      lifecycle.readyContext.eventSource.removeListener?.(
        lifecycle.readyType,
        mount,
      );
  }
  delete lifecycle.readyContext;
  delete lifecycle.readyType;
  lifecycle.runtime?.stop();
  lifecycle.root?.unmount();
  document.getElementById('rp-state-machine-root')?.remove();
  delete lifecycle.root;
  delete lifecycle.runtime;
};
window.addEventListener(
  'beforeunload',
  () => window.rpStateMachineDispose?.(),
  { once: true },
);
function waitForAppReady() {
  if (lifecycle.root || lifecycle.readyContext) return;
  const ctx = context();
  const ready = ctx.eventTypes.APP_READY;
  // Third-party extensions are loaded during app initialization; wait for the
  // supported lifecycle signal rather than assuming the DOM implies readiness.
  if (ready) {
    lifecycle.readyContext = ctx;
    lifecycle.readyType = ready;
    ctx.eventSource.on(ready, mount);
  } else mount();
}
/** SillyTavern manifest lifecycle hooks; retained as ESM exports by Webpack. */
export function onEnable() {
  mount();
}
/** Called for already-enabled extensions during normal client startup. */
export function onActivate() {
  waitForAppReady();
}
export function onDisable() {
  window.rpStateMachineDispose?.();
}
export function onClean() {
  window.rpStateMachineDispose?.();
}
