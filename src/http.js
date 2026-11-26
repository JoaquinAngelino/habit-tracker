// `code` names the i18n message for the error; `conflict` marks a write refused because the data changed.
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
