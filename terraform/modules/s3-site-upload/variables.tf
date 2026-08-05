variable "bucket" {
  description = "Name of the S3 bucket to upload into."
  type        = string
}

variable "source_dir" {
  description = "Absolute path of the directory to upload. Its contents are mirrored to the bucket root, preserving subdirectories."
  type        = string
}

variable "cache_control" {
  description = "Cache-Control header set on every uploaded object."
  type        = string
  default     = "public, max-age=60"
}

variable "content_types" {
  description = "Extension (without dot) to Content-Type mapping. Unlisted extensions fall back to content_type_default."
  type        = map(string)
  default = {
    html        = "text/html; charset=utf-8"
    htm         = "text/html; charset=utf-8"
    css         = "text/css; charset=utf-8"
    js          = "application/javascript; charset=utf-8"
    mjs         = "application/javascript; charset=utf-8"
    map         = "application/json; charset=utf-8"
    json        = "application/json; charset=utf-8"
    txt         = "text/plain; charset=utf-8"
    xml         = "application/xml; charset=utf-8"
    svg         = "image/svg+xml"
    png         = "image/png"
    jpg         = "image/jpeg"
    jpeg        = "image/jpeg"
    gif         = "image/gif"
    webp        = "image/webp"
    avif        = "image/avif"
    ico         = "image/x-icon"
    woff        = "font/woff"
    woff2       = "font/woff2"
    ttf         = "font/ttf"
    otf         = "font/otf"
    wasm        = "application/wasm"
    pdf         = "application/pdf"
    webmanifest = "application/manifest+json"
  }
}

variable "content_type_default" {
  description = "Content-Type used for extensions not present in content_types."
  type        = string
  default     = "application/octet-stream"
}
