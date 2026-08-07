const ISO_4217_MINOR_UNITS: Record<string, number> = {
  BHD: 3,
  BIF: 0,
  CLP: 0,
  CZK: 2,
  DJF: 0,
  EUR: 2,
  GBP: 2,
  ISK: 0,
  IQD: 3,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PLN: 2,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  USD: 2,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

/**
 * How many digits ISO 4217 gives the currency's minor unit, so 2 for a crown and a
 * euro, 0 for a yen and 3 for a dinar.
 *
 * There is no sane default here, which is why an unlisted code throws rather than
 * being treated as two. Assuming two turns 1000 yen into 10 and a dinar into a
 * tenth of itself, and a payment library that guesses at this is a payment library
 * that moves the wrong amount.
 */
export function minorUnitsOf(currency: string): number {
  const digits = ISO_4217_MINOR_UNITS[currency.toUpperCase()];
  if (digits === undefined) {
    throw new Error(
      `${currency.toUpperCase()} is not a currency this knows the ISO 4217 minor unit of`,
    );
  }

  return digits;
}

/** The scale that minor unit implies, so 100 for a crown, 1 for a yen, 1000 for a dinar */
export function minorScaleOf(currency: string): number {
  return 10 ** minorUnitsOf(currency);
}
