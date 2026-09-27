from fastapi import FastAPI

from app.notifications.worker import router as notifications_router
from app.users.router import router as users_router

app = FastAPI(title="tandem")
app.include_router(users_router)
app.include_router(notifications_router)


@app.get("/health")
def health():
    return {"ok": True}
