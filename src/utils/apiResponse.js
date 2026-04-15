class ApiResponse {
  static success(res, data, statusCode = 200) {
    return res.status(statusCode).json({ success: true, data });
  }

  static created(res, data) {
    return res.status(201).json({ success: true, data });
  }

  static error(res, message, statusCode = 500) {
    return res.status(statusCode).json({ success: false, error: message });
  }

  static notFound(res, message = 'Ressource non trouvée') {
    return res.status(404).json({ success: false, error: message });
  }

  static forbidden(res, message = 'Accès refusé') {
    return res.status(403).json({ success: false, error: message });
  }

  static badRequest(res, message = 'Requête invalide') {
    return res.status(400).json({ success: false, error: message });
  }
}

module.exports = ApiResponse;
