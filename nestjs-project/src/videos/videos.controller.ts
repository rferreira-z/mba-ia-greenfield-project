import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateUploadPartUrlsDto } from './dto/create-upload-part-urls.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { UploadPartUrlsResponseDto } from './dto/upload-part-urls-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

// Rate limiting stays scoped to auth endpoints (inherited phase-02-auth/TD-08).
@SkipThrottle()
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and starts a direct-to-storage multipart upload. The response carries the upload plan (part size and count); request presigned part URLs next.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (incl. size above 10 GiB, MIME type)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Authenticated user has no channel',
    schema: errorSchema,
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createUpload(user.sub, dto);
  }

  @Post(':slug/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Presign upload part URLs',
    description:
      'Returns presigned PUT URLs for the requested part numbers of a draft upload. The client sends each part directly to object storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: UploadPartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not in progress (status is not draft)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 422,
    description: 'Part number outside the upload part range',
    schema: errorSchema,
  })
  async createPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Body() dto: CreateUploadPartUrlsDto,
  ): Promise<UploadPartUrlsResponseDto> {
    return this.videosService.presignUploadParts(
      slug,
      user.sub,
      dto.part_numbers,
    );
  }

  @Post(':slug/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Verifies the uploaded parts, completes the multipart upload, moves the video to processing and enqueues automatic processing (duration, metadata, thumbnail).',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing queued',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not in progress (already completed)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 422,
    description:
      'Uploaded parts are missing or their total size differs from the declared size',
    schema: errorSchema,
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(slug, user.sub);
  }

  @Get(':slug')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get one of my videos',
    description:
      'Returns a video owned by the caller in any status — used to follow upload and processing progress.',
  })
  @ApiResponse({
    status: 200,
    description: 'The video',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedVideo(slug, user.sub);
  }

  @Public()
  @Get(':slug/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a short-lived presigned storage URL. Storage serves HTTP Range requests with 206 Partial Content, so playback starts without downloading the whole file. Public for ready videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned stream URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: errorSchema,
  })
  async stream(@Param('slug') slug: string): Promise<{ url: string }> {
    return { url: await this.videosService.getStreamUrl(slug) };
  }

  @Public()
  @Get(':slug/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a short-lived presigned storage URL whose response carries Content-Disposition: attachment with the original file name. Public for ready videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: errorSchema,
  })
  async download(@Param('slug') slug: string): Promise<{ url: string }> {
    return { url: await this.videosService.getDownloadUrl(slug) };
  }

  @Public()
  @Get(':slug/thumbnail')
  @Redirect()
  @ApiOperation({
    summary: 'Get a video thumbnail',
    description:
      'Redirects (302) to a short-lived presigned URL of the JPEG thumbnail generated during processing. Public for ready videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned thumbnail URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready yet',
    schema: errorSchema,
  })
  async thumbnail(@Param('slug') slug: string): Promise<{ url: string }> {
    return { url: await this.videosService.getThumbnailUrl(slug) };
  }
}
