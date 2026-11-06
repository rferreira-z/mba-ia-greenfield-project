import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class UploadPlanDto {
  @ApiProperty({
    example: 67108864,
    description: 'Size of every part except the last',
  })
  part_size_bytes: number;

  @ApiProperty({ example: 160, description: 'Number of parts to upload' })
  part_count: number;

  @ApiProperty({
    example: 100,
    description: 'Maximum part numbers per part-urls request',
  })
  max_part_urls_per_request: number;
}

export class CreateVideoResponseDto {
  @ApiProperty({ type: VideoResponseDto })
  video: VideoResponseDto;

  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}
