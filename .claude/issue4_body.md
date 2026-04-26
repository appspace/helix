## Problem

`src/App.tsx` declares `tabCounter` at module scope, outside the React component:

```ts
// line 24 — module level, shared across all renders
let tabCounter = 1;
```

This is an anti-pattern for a few reasons:

1. **Wrong React primitive.** Mutable values that should outlive renders but not cause re-renders belong in a `useRef`, not a module-level variable. `useRef` is scoped to the component instance, while a module variable is shared globally across all instances and survives unmount/remount.

2. **Strict Mode double-invoke.** React 18 Strict Mode intentionally unmounts and remounts components in development to surface side-effects. When `App` remounts, `tabCounter` is NOT reset to `1` (it persists from the previous mount), so the very first tab opened after a remount gets an unexpected ID.

3. **Hot-reload drift.** In Vite HMR, module-level state is preserved across hot reloads while component state is reset. This means `tabCounter` and the `tabs` state array can get out of sync after a save.

4. **`handleNewTab` reads a stale value.** The naming logic `query_${tabCounter + 1}.sql` reads the counter before `addTab` increments it. This works by coincidence today but becomes fragile if `addTab` is ever called from more than one place in the same render.

## Expected fix

Replace the module-level variable with a `useRef` inside the component:

```ts
const tabCounter = useRef(1);

const addTab = (name: string, query: string) => {
  tabCounter.current += 1;
  const id = String(tabCounter.current);
  setTabs(ts => [...ts, { id, name, query }]);
  setActiveTab(id);
  // ...
};

const handleNewTab = () => addTab(`query_${tabCounter.current + 1}.sql`, '');
```

## File

`src/App.tsx` line 24
