---
"@crowi/web": patch
---

Fix the editor image display-attribute affordance showing two stacked panels over the same image. When the caret sat inside an image's Markdown while the mouse also hovered it (e.g. right after clicking the markup to edit it), the hover trigger and the cursor trigger each rendered their own identical panel. The hover trigger now yields to the (stable) cursor trigger on the same image span, and if a hover panel is already open when the caret enters that span it closes so only one panel remains. A hover panel for a different image is left untouched.
