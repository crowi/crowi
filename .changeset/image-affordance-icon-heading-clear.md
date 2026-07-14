---
"@crowi/web": patch
---

Editor image display-attribute affordance: the `align` / `float` controls now show icons instead of the text labels `align: left` … `float: right`. The `align` icons depict where the image box sits within the frame; the `float` icons depict an image box with text wrapping around it, so the effect is recognisable at a glance. The former text label is preserved as each button's hover tooltip and accessible name (`aria-label`), and the selected-state highlight is unchanged. Separately, floated images now always clear at the next section heading (`#`–`######`) in both page view and the editor preview, so a heading no longer wraps alongside a preceding floated image.
