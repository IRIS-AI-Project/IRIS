import catalog from "../../../backend/app/model_manager/catalog.json";

// The two speech models are downloaded after installation. Small supporting
// models do not change this rounded estimate; application files are separate.
const speechModels = new Set(["gigaam-v3-rnnt", "teratts-v2"]);
const bytes = catalog.filter(model => speechModels.has(model.id))
  .reduce((total, model) => total + model.size_bytes, 0);

export const VOICE_MODELS_DOWNLOAD_SIZE = `${(bytes / 1_000_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;
