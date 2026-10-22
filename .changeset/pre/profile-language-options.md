---
"@crowi/web": patch
---

Remove the non-functional "English (US)" / "English (UK)" entries from the
profile language selector, leaving only the locales we actually ship messages
for (English / 日本語). Existing users whose saved `lang` is a regional
variant are shown "English" pre-selected.
