import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoMetadataDto {
  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ nullable: true, example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format_name: string | null;

  @ApiProperty({ nullable: true, example: 4000000 })
  bit_rate: number | null;

  @ApiProperty({ nullable: true, example: 29.97 })
  frame_rate: number | null;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'aZ3kQ9xLm2P',
    description: 'Unique public identifier used in every /videos/{slug} URL',
  })
  slug: string;

  @ApiProperty({ example: 'My holiday' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 'holiday.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 1048576 })
  size_bytes: number;

  @ApiProperty({ nullable: true, example: 12.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ nullable: true, example: null })
  failure_reason: string | null;

  @ApiProperty({
    example: 'http://localhost:3000/videos/aZ3kQ9xLm2P/stream',
    description: 'Unique streaming URL (redirects to storage; 409 until ready)',
  })
  stream_url: string;

  @ApiProperty({
    example: 'http://localhost:3000/videos/aZ3kQ9xLm2P/download',
    description: 'Unique download URL (redirects to storage; 409 until ready)',
  })
  download_url: string;

  @ApiProperty({
    nullable: true,
    example: 'http://localhost:3000/videos/aZ3kQ9xLm2P/thumbnail',
    description: 'Thumbnail URL once processing generated it, otherwise null',
  })
  thumbnail_url: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  processed_at: Date | null;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;

  @ApiProperty({ format: 'date-time' })
  updated_at: Date;
}
