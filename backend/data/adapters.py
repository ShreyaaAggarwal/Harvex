"""
HARVEX — Data Adapter Boundary
---------------------------------
The rest of the system (agents, Ripple Engine, API layer) only ever reads
from the SQLite operational database via database.py — it never depends on
where a row originally came from. This module is the seam where the
official HACKNITE datasets/APIs (Product Catalog, Inventory, Sales,
Procurement, Sample Produce Images, Demand, Quality, Operational data)
would be wired in to REPLACE seed_data.py, without touching agents,
the Ripple Engine, or the frontend.

Each adapter below is a stub with the shape the loader expects. Swap the
body for a real API/file client and set is_simulated=0 on the rows it
writes; nothing downstream needs to change.
"""


class BaseDatasetAdapter:
    """Contract every official-dataset adapter should follow."""
    source_name = "unset"

    def fetch_products(self):
        raise NotImplementedError

    def fetch_inventory(self):
        raise NotImplementedError

    def fetch_sales(self):
        raise NotImplementedError

    def fetch_procurement(self):
        raise NotImplementedError

    def fetch_demand(self):
        raise NotImplementedError

    def fetch_quality(self):
        raise NotImplementedError

    def fetch_operational(self):
        raise NotImplementedError


class SyntheticSeedAdapter(BaseDatasetAdapter):
    """Current prototype data source — see seed_data.py. Everything it
    writes is flagged is_simulated=1 throughout the schema."""
    source_name = "synthetic_seed_v1"


class OfficialHacknightDatasetAdapter(BaseDatasetAdapter):
    """Placeholder for the official HACKNITE CODE ROYALE dataset/API feed.
    Not implemented — datasets were not available during development.
    Implement fetch_* here against the real feed and point seed_data.py's
    loader at this adapter instead of SyntheticSeedAdapter."""
    source_name = "hacknite_official_v1"

    def fetch_products(self):
        raise NotImplementedError("Official dataset feed not yet connected.")
