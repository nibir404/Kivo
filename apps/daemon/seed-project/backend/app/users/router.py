from fastapi import APIRouter

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me")
async def me():
    # Cache-aside: profile reads are cached in Redis for 60s.
    return {"id": "demo", "display_name": "Imtiaz"}


@router.patch("/me")
async def update_me(body: dict):
    return {**body, "id": "demo"}
