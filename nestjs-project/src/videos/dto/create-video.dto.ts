import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_VIDEO_SIZE_BYTES,
} from '../videos.constants';

export class CreateVideoDto {
  /** Video title. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  /** Original file name, e.g. `holiday.mp4`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name: string;

  /** File size in bytes — at most 10 GiB (10737418240). */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  file_size: number;

  /** Declared MIME type; stored as the object's Content-Type. */
  @IsIn(ALLOWED_VIDEO_MIME_TYPES)
  mime_type: (typeof ALLOWED_VIDEO_MIME_TYPES)[number];
}
