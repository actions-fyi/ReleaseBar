// A Svelte action, kept apart from app-format.ts: it needs the DOM, and app-format.ts is also
// compiled with the Worker tests, which have no DOM types.
export function fitDetailValue(node: HTMLElement, _value: string | number | null) {
  let frame = 0;
  const minSize = 20;
  const preferredSize = (): number => {
    const parsed = Number.parseFloat(
      getComputedStyle(node).getPropertyValue("--detail-value-size"),
    );
    return Number.isFinite(parsed) ? parsed : 42;
  };
  const fit = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const preferred = preferredSize();
      node.style.setProperty("--detail-fit-size", `${preferred}px`);
      const rendered = Number.parseFloat(getComputedStyle(node).fontSize);
      const base = Number.isFinite(rendered) ? rendered : preferred;
      const next =
        node.clientWidth > 0 && node.scrollWidth > node.clientWidth
          ? Math.max(minSize, Math.floor(base * (node.clientWidth / node.scrollWidth) * 0.96))
          : preferred;
      node.style.setProperty("--detail-fit-size", `${next}px`);
    });
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
  observer?.observe(node);
  fit();
  return {
    update: fit,
    destroy() {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    },
  };
}
