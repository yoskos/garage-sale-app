from typing import Optional
from pydantic import BaseModel


class PriceResponse(BaseModel):
    item: str
    condition_observed: str
    suggested_price_usd: float
    price_range_usd: list[float]
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
