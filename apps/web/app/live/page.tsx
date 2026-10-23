import { config } from "../../lib/config";
import { LivePrices } from "./live-prices";

export default function LivePage() {
  return <LivePrices apiUrl={config.apiUrl} symbols={config.symbols} />;
}
