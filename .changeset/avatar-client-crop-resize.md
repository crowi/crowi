---
'@crowi/web': minor
---

Profile picture upload now opens a crop dialog: you pick a square region (drag to reposition, slider to zoom), and only the cropped image — downscaled to 256×256 and re-encoded (WebP, PNG fallback) on the client — is uploaded. Previously the originally selected file was sent as-is, so a multi-megapixel phone photo would upload at full size. The API contract is unchanged (same multipart `file` field).
