<script>
  // Small stroke icons for components and stimulus nodes (24×24 grid, currentColor).
  let { name = 'generic', size = 16 } = $props();
  const P = {
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
    led: 'M8 4h8v9a4 4 0 0 1-8 0zM10 17v4M14 17v4M4 8l2 1M20 8l-2 1',
    fan: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 10c0-4 1-7 4-7 2 0 2 3 0 5M14 12c4 0 7 1 7 4 0 2-3 2-5 0M12 14c0 4-1 7-4 7-2 0-2-3 0-5M10 12c-4 0-7-1-7-4 0-2 3-2 5 0',
    pump: 'M4 14h4l2-4h4l2 4h4M12 10V5M9 5h6M6 14v5h12v-5',
    motor: 'M4 7h12v10H4zM16 10h3v4h-3M7 7V4h6v3M7 17v3M13 17v3',
    wiper: 'M12 20L5 7M12 20l1.5-1M3 20h18M5 7l1-2',
    coil: 'M3 12h3M18 12h3M6 12c0-3 2-3 2 0s2 3 2 0 2-3 2 0 2 3 2 0 2-3 2 0',
    horn: 'M4 10v4h3l6 4V6l-6 4zM17 9c1 1 1 5 0 6M19.5 7c2 2.5 2 7.5 0 10',
    heater: 'M8 4c-2 3 2 5 0 8s2 5 0 8M12 4c-2 3 2 5 0 8s2 5 0 8M16 4c-2 3 2 5 0 8s2 5 0 8',
    chip: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
    bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
    generic: 'M4 12h3l2-4 3 8 2-4h6',
    switch: 'M3 16h4M17 16h4M7 16l9-7M16 16h1',
    knob: 'M12 13m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M12 13l3-4M12 3v2M4 7l1.5 1M20 7l-1.5 1',
    keypad: 'M4 5h16v14H4zM8 9h1M12 9h1M16 9h0M8 13h1M12 13h1M16 13h0M8 16h8',
    can: 'M3 8h18M3 16h18M7 8v8M12 8v8M17 8v8',
    engine: 'M5 9h3V6h6v3h2l2 2h2v6h-2l-2 2H8l-3-3zM2 12h3',
    battery: 'M3 7h18v12H3zM7 4v3M17 4v3M6 13h4M15 11v4M13 13h4',
    module: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={P[name] || P.generic} />
</svg>
