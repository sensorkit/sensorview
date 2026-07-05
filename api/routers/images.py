"""Image thumbnail endpoints — future FITS preview support."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/thumbnail/{image_id}")
async def get_thumbnail(image_id: str):
    """Generate a PNG thumbnail from a FITS file. (Not yet implemented.)"""
    return {"status": "not_implemented", "image_id": image_id}
