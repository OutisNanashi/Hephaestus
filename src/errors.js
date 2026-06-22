export class HephaestusError extends Error {
  constructor(message, code = "HEPHAESTUS_ERROR") {
    super(message);
    this.name = "HephaestusError";
    this.code = code;
  }
}

export function fail(message, code) {
  throw new HephaestusError(message, code);
}
