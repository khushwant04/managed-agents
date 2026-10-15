"""Object storage for artifacts, skill bundles, sandbox snapshots and recordings.

``file:///path`` stores on local disk (development); ``s3://bucket/prefix``
uses any S3-compatible service such as MinIO (needs the ``s3`` extra; the
endpoint and credentials come from the usual ``AWS_*`` environment variables
and ``AWS_ENDPOINT_URL``).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Protocol
from urllib.parse import urlparse


class BlobStore(Protocol):
    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None: ...

    async def get(self, key: str) -> bytes: ...

    async def delete(self, key: str) -> None: ...


class FileBlobStore:
    def __init__(self, root: str) -> None:
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError(f"invalid blob key {key!r}")
        return p

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(p.write_bytes, data)

    async def get(self, key: str) -> bytes:
        return await asyncio.to_thread(self._path(key).read_bytes)

    async def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class S3BlobStore:
    def __init__(self, bucket: str, prefix: str = "") -> None:
        try:
            import boto3
        except ImportError as exc:  # pragma: no cover
            raise ImportError("S3 storage needs boto3: pip install 'runhive-server[s3]'") from exc
        self._s3 = boto3.client("s3")
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def _key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        extra = {"ContentType": content_type} if content_type else {}
        await asyncio.to_thread(self._s3.put_object, Bucket=self.bucket, Key=self._key(key), Body=data, **extra)

    async def get(self, key: str) -> bytes:
        obj = await asyncio.to_thread(self._s3.get_object, Bucket=self.bucket, Key=self._key(key))
        return await asyncio.to_thread(obj["Body"].read)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._s3.delete_object, Bucket=self.bucket, Key=self._key(key))


def blob_store(url: str) -> BlobStore:
    u = urlparse(url)
    if u.scheme == "file":
        return FileBlobStore(u.path)
    if u.scheme == "s3":
        return S3BlobStore(u.netloc, u.path)
    raise ValueError(f"unsupported blob store URL {url!r}")
