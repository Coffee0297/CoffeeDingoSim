<script>
  // Card title that renames in place: double-click (or Enter when focused) to edit, Enter/blur saves,
  // Escape cancels, an empty name goes back to the default (`onsave(null)`).
  let { value, placeholder = '', onsave } = $props();
  let editing = $state(false);
  let draft = $state('');

  function start() { draft = value ?? ''; editing = true; }
  function commit() {
    if (!editing) return;
    editing = false;
    const v = draft.trim();
    if (v !== (value ?? '')) onsave(v || null);
  }
  function focus(el) { el.focus(); el.select(); }
</script>

{#if editing}
  <input class="input title-edit nodrag" bind:value={draft} {placeholder} use:focus onblur={commit}
    onkeydown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') editing = false; e.stopPropagation(); }} />
{:else}
  <span class="title" role="button" tabindex="0" title="Double-click to rename" ondblclick={start}
    onkeydown={(e) => e.key === 'Enter' && start()}>{value || placeholder}</span>
{/if}

<style>
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; cursor: text; min-width: 0; }
  .title-edit { flex: 1; min-width: 0; padding: 1px 4px; font: inherit; font-weight: 600; }
</style>
