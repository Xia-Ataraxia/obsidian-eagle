// Node test env has no `window`; plugin code uses window timers for popout-window compatibility.
Object.assign(globalThis, { window: globalThis })
