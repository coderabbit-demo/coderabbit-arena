import { createApp } from "./api/app";
import { BookingService } from "./services/bookingService";
import { InMemoryStore } from "./store/store";

const PORT = Number(process.env.PORT ?? 3000);

const store = new InMemoryStore();
const service = new BookingService(store);
const app = createApp(service);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Booking API listening on http://localhost:${PORT}`);
});
