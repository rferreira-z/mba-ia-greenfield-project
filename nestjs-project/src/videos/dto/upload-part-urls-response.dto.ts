import { ApiProperty } from '@nestjs/swagger';

export class UploadPartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description:
      'Presigned PUT URL — send the raw part bytes directly to object storage',
  })
  url: string;
}

export class UploadPartUrlsResponseDto {
  @ApiProperty({ type: [UploadPartUrlDto] })
  parts: UploadPartUrlDto[];

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}
