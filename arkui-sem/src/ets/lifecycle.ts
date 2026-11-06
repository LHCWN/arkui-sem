// ArkUI custom-component lifecycle hooks.

export const LIFECYCLE = new Set([
  'aboutToAppear',
  'aboutToDisappear',
  'onPageShow',
  'onPageHide',
  'onBackPress',
  'aboutToReuse',
  'aboutToRecycle',
  'onDidBuild',
]);
/** Hooks that acquire resources, and the hooks that should release them. */
export const ACQUIRE_HOOKS = new Set(['aboutToAppear', 'onPageShow', 'aboutToReuse', 'onDidBuild']);
export const RELEASE_HOOKS = new Set(['aboutToDisappear', 'onPageHide', 'aboutToRecycle']);
