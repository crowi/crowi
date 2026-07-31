---
'@crowi/cli': patch
---

`crowi attach add` now declares the file's media type when uploading, so an uploaded image is stored as an image instead of `application/octet-stream`. Previously the multipart part carried no type, and since attachment delivery only serves an allow-listed type inline, a PNG uploaded through the CLI came back as a download. Attachments already uploaded keep their recorded `application/octet-stream` type — re-upload them to correct it.
