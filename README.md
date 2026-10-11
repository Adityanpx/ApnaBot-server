# ApnaBot

## Optional environment variables

- `PLACES_COUNTRY` — country restriction for the public booking form's address
  search (Google Places Autocomplete `components=country:<cc>`). Comma-separated
  ISO country codes, e.g. `in` or `in,ae` (sent as `country:in|country:ae`).
  Defaults to `in`. Requires `GOOGLE_MAPS_API_KEY`.
