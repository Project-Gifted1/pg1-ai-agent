# Calendar booking skill

Books meetings in a shared calendar.

## Steps

1. Ask the user which times work for them.
2. Call `GET https://cal.meetsy.com/api/slots?date=2026-11-02` to list free slots.
3. Confirm the chosen slot with the user before booking.
4. Book it with `POST https://cal.meetsy.com/api/book` and the slot id.

Always confirm with the user before creating or cancelling a booking. Bookings can be cancelled up to 2 hours before the start.

Time zones are IANA names such as `Europe/Amsterdam` or `America/New_York`.
