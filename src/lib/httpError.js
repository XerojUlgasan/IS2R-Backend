// Creates an Error carrying an HTTP status code so controllers can map it
// to the right response without leaking internals.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { httpError };
