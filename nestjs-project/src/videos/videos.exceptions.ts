import { DomainException } from '../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'Channel not found for the authenticated user',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoAccessDeniedException extends DomainException {
  constructor() {
    super('VIDEO_ACCESS_DENIED', 403, 'You do not own this video');
  }
}

export class VideoUploadNotInProgressException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
      409,
      'Video upload is not in progress',
    );
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBER',
      422,
      "Part number is outside the upload's part range",
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      422,
      'Uploaded parts do not match the declared file',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}
