import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 ** 3;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `owner${n}`,
        nickname: `owner_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channel: Channel, overrides: Partial<Video> = {}) {
    const id = randomUUID();
    return videoRepository.create({
      id,
      slug: `slug${String(++counter).padStart(7, '0')}`,
      channel_id: channel.id,
      title: 'My video',
      original_filename: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      part_size_bytes: 64 * 1024 * 1024,
      source_key: `videos/${id}/source`,
      upload_id: 'upload-id',
      ...overrides,
    });
  }

  it('should default status to draft and keep the service-generated id', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel);

    await videoRepository.save(video);
    const found = await videoRepository.findOneByOrFail({ id: video.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.source_key).toBe(`videos/${video.id}/source`);
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
  });

  it('should enforce a unique slug', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel, { slug: 'dupSlug0001' }));

    await expect(
      videoRepository.save(buildVideo(channel, { slug: 'dupSlug0001' })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should round-trip a 10 GiB size as a number', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel, { size_bytes: TEN_GIB });

    await videoRepository.save(video);
    const found = await videoRepository.findOneByOrFail({ id: video.id });

    expect(found.size_bytes).toBe(10737418240);
    expect(typeof found.size_bytes).toBe('number');
  });

  it('should persist metadata as jsonb', async () => {
    const channel = await createChannel();
    const metadata = {
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: null,
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      bit_rate: 4_000_000,
      frame_rate: 29.97,
    };
    const video = buildVideo(channel, {
      status: VideoStatus.READY,
      metadata,
      duration_seconds: 12.5,
    });

    await videoRepository.save(video);
    const found = await videoRepository.findOneByOrFail({ id: video.id });

    expect(found.metadata).toEqual(metadata);
    expect(found.duration_seconds).toBe(12.5);
  });

  it('should delete videos when their channel is deleted', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel));

    await channelRepository.delete(channel.id);

    expect(await videoRepository.findOneBy({ id: video.id })).toBeNull();
  });
});
