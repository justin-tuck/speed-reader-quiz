/** An import failure with a message that is safe to show to the user. */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}
