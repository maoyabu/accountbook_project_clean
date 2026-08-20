const { format } = require('node:util');

/**
 * Session-backed flash messages.
 *
 * This keeps the req.flash API used throughout the application without
 * loading connect-flash, which calls Node's deprecated util.isArray API.
 */
module.exports = function flash() {
  return function flashMiddleware(req, res, next) {
    req.flash = function flashMessage(type, message) {
      if (!req.session) {
        throw new Error('req.flash() requires sessions');
      }

      const messages = req.session.flash || (req.session.flash = {});

      if (type && arguments.length > 1) {
        let values = message;
        if (arguments.length > 2) {
          values = format(...Array.prototype.slice.call(arguments, 1));
        }

        if (!Array.isArray(values)) values = [values];
        messages[type] = messages[type] || [];
        messages[type].push(...values);
        return messages[type].length;
      }

      if (type) {
        const values = messages[type] || [];
        delete messages[type];
        return values;
      }

      req.session.flash = {};
      return messages;
    };

    next();
  };
};
