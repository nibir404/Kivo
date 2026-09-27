from fastapi import APIRouter

router = APIRouter(prefix="/notify", tags=["notifications"])
QUEUE: list = []


@router.post("", status_code=202)
async def enqueue(message: dict):
    QUEUE.append(message)  # production: LPUSH notify:queue
    return {"queued": True}


@router.get("/preferences")
async def preferences():
    return {"email": True, "push": True}
