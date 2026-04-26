## Problem

When a connection is established, `handleConnect` in `src/App.tsx` calls `loadSchema` explicitly:

```ts
// line 80
if (initial) await loadSchema(initial);
// ...
setActiveSchema(initial);   // line 87 — triggers the useEffect below
```

Then a `useEffect` watches `activeSchema` and fires `loadSchema` whenever it changes:

```ts
// lines 293-295
useEffect(() => {
  if (connected && activeSchema) loadSchema(activeSchema);
}, [activeSchema, connected, loadSchema]);
```

Because `setActiveSchema(initial)` is called immediately after the explicit `loadSchema` call, and `connected` is set to `true` in the same batch, the effect fires and calls `loadSchema` a second time. The result is two identical `GET /api/schema?schema=<name>` requests sent to the server on every new connection.

## Steps to reproduce

1. Open the Network tab in browser DevTools.
2. Connect to a MySQL server with any schema.
3. Observe two identical requests to `/api/schema?schema=<dbname>` fired in rapid succession.

## Expected behaviour

The schema should be fetched exactly once on connection. Either:

- Remove the explicit `loadSchema(initial)` call from `handleConnect` and let the `useEffect` handle it (simplest fix), or
- Remove the `useEffect` entirely and call `loadSchema` explicitly wherever the schema needs to reload (more predictable data-flow).

## File

`src/App.tsx` — `handleConnect` (line 80) and the `useEffect` at lines 293-295.
