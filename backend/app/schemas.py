from typing import Optional
from pydantic import BaseModel


class PriceResponse(BaseModel):
    item: str
    condition_observed: str
    suggested_price_usd: float
    price_range_usd: list[float]
    retail_price_new_usd: float | None = None
    rationale: str
    cache_hit: bool
    request_id: str


class SaleRequest(BaseModel):
    request_id: Optional[str] = None
    item_label: str
    suggested_price_usd: Optional[float] = None
    sold_price_usd: Optional[float] = None
    sold: bool
    notes: Optional[str] = None


class SaleResponse(BaseModel):
    logged: bool
    id: int


class SummaryTopItem(BaseModel):
    item_label: str
    sold_price_usd: float


class SummaryResponse(BaseModel):
    total_items_priced: int
    total_items_sold: int
    total_revenue_usd: float
    avg_discount_vs_suggested: float
    top_items: list[SummaryTopItem]


class HealthResponse(BaseModel):
    ok: bool


class UploadResponse(BaseModel):
    upload_id: str


class ParseSaleRequest(BaseModel):
    text: str


class ParseSaleResponse(BaseModel):
    item_label: str
    sold_price_usd: float


class PriceRequest(BaseModel):
    upload_ids: list[str]
    notes: str | None = None


class LedgerEntry(BaseModel):
    id: int
    item_label: str
    sold_price_usd: float | None
    sold: bool
    created_at: int


class LedgerResponse(BaseModel):
    entries: list[LedgerEntry]


class SaleUpdateRequest(BaseModel):
    item_label: str | None = None
    sold_price_usd: float | None = None


class SearchHit(BaseModel):
    item: str
    condition_observed: str
    suggested_price_usd: float
    price_range_usd: list[float]
    retail_price_new_usd: float | None = None
    rationale: str
    notes: str
    created_at: int


class SearchResponse(BaseModel):
    results: list[SearchHit]
