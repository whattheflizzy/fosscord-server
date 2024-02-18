import { PublicUser, User } from "./User";
import { Message } from "./Message";
import {
	BeforeInsert,
	BeforeUpdate,
	Column,
	Entity,
	Index,
	JoinColumn,
	JoinTable,
	ManyToMany,
	ManyToOne,
	Not,
	PrimaryGeneratedColumn,
	RelationId,
} from "typeorm";
import { Guild } from "./Guild";
import { Config, emitEvent, FieldErrors } from "../util";
import {
	GuildCreateEvent,
	GuildDeleteEvent,
	GuildMemberAddEvent,
	GuildMemberRemoveEvent,
	GuildMemberUpdateEvent,
	MessageCreateEvent,
} from "../interfaces";
import { HTTPError } from "lambert-server";
import { Role } from "./Role";
import { BaseClassWithoutId } from "./BaseClass";
import { Ban, PublicGuildRelations } from ".";
import { DiscordApiErrors } from "../util/Constants";
import { ReadyGuildDTO } from "../dtos";

export const MemberPrivateProjection: (keyof Member)[] = [
	"id",
	"guild",
	"guild_id",
	"deaf",
	"joined_at",
	"last_message_id",
	"mute",
	"nick",
	"pending",
	"premium_since",
	"roles",
	"settings",
	"user",
];

@Entity("members")
@Index(["id", "guild_id"], { unique: true })
export class Member extends BaseClassWithoutId {
	@PrimaryGeneratedColumn()
	index: string;

	@Column()
	@RelationId((member: Member) => member.user)
	id: string;

	@JoinColumn({ name: "id" })
	@ManyToOne(() => User, {
		onDelete: "CASCADE",
	})
	user: User;

	@Column()
	@RelationId((member: Member) => member.guild)
	guild_id: string;

	@JoinColumn({ name: "guild_id" })
	@ManyToOne(() => Guild, {
		onDelete: "CASCADE",
	})
	guild: Guild;

	@Column({ nullable: true })
	nick?: string;

	@JoinTable({
		name: "member_roles",
		joinColumn: { name: "index", referencedColumnName: "index" },
		inverseJoinColumn: {
			name: "role_id",
			referencedColumnName: "id",
		},
	})
	@ManyToMany(() => Role, { cascade: true })
	roles: Role[];

	@Column()
	joined_at: Date;

	@Column({ type: "bigint", nullable: true })
	premium_since?: number;

	@Column()
	deaf: boolean;

	@Column()
	mute: boolean;

	@Column()
	pending: boolean;

	@Column({ type: "simple-json", select: false })
	settings: UserGuildSettings;

	@Column({ nullable: true })
	last_message_id?: string;

	/**
	@JoinColumn({ name: "id" })
	@ManyToOne(() => User, {
		onDelete: "DO NOTHING",
	// do not auto-kick force-joined members just because their joiners left the server
	}) **/
	@Column({ nullable: true })
	joined_by: string;

	@Column({ nullable: true })
	avatar: string;

	@Column({ nullable: true })
	banner: string;

	@Column()
	bio: string;

	@Column({ nullable: true, type: "simple-array" })
	theme_colors?: number[]; // TODO: Separate `User` and `UserProfile` models

	@Column({ nullable: true })
	pronouns?: string;

	@Column({ nullable: true })
	communication_disabled_until: Date;

	// TODO: add this when we have proper read receipts
	// @Column({ type: "simple-json" })
	// read_state: ReadState;

	@BeforeUpdate()
	@BeforeInsert()
	validate() {
		if (this.nick) {
			this.nick = this.nick.split("\n").join("");
			this.nick = this.nick.split("\t").join("");
		}
	}

	static async IsInGuildOrFail(user_id: string, guild_id: string) {
		if (
			await Member.count({
				where: { id: user_id, guild: { id: guild_id } },
			})
		)
			return true;
		throw new HTTPError("You are not member of this guild", 403);
	}

	static async removeFromGuild(user_id: string, guild_id: string) {
		const guild = await Guild.findOneOrFail({
			select: ["owner_id"],
			where: { id: guild_id },
		});
		if (guild.owner_id === user_id)
			throw new Error("The owner cannot be removed of the guild");
		const member = await Member.findOneOrFail({
			where: { id: user_id, guild_id },
			relations: ["user"],
		});

		// use promise all to execute all promises at the same time -> save time
		return Promise.all([
			Member.delete({
				id: user_id,
				guild_id,
			}),
			Guild.decrement({ id: guild_id }, "member_count", -1),

			emitEvent({
				event: "GUILD_DELETE",
				data: {
					id: guild_id,
				},
				user_id: user_id,
			} as GuildDeleteEvent),
			emitEvent({
				event: "GUILD_MEMBER_REMOVE",
				data: { guild_id, user: member.user },
				guild_id,
			} as GuildMemberRemoveEvent),
		]);
	}

	static async addRole(user_id: string, guild_id: string, role_id: string) {
		const [member, role] = await Promise.all([
			Member.findOneOrFail({
				where: { id: user_id, guild_id },
				relations: ["user", "roles"], // we don't want to load  the role objects just the ids
				//@ts-ignore
				select: ["index", "roles.id"], // TODO fix type
			}),
			Role.findOneOrFail({
				where: { id: role_id, guild_id },
				select: ["id"],
			}),
		]);
		member.roles.push(Role.create({ id: role_id }));

		await Promise.all([
			member.save(),
			emitEvent({
				event: "GUILD_MEMBER_UPDATE",
				data: {
					guild_id,
					user: member.user,
					roles: member.roles.map((x) => x.id),
				},
				guild_id,
			} as GuildMemberUpdateEvent),
		]);
	}

	static async removeRole(
		user_id: string,
		guild_id: string,
		role_id: string,
	) {
		const [member] = await Promise.all([
			Member.findOneOrFail({
				where: { id: user_id, guild_id },
				relations: ["user", "roles"], // we don't want to load  the role objects just the ids
				//@ts-ignore
				select: ["roles.id", "index"], // TODO: fix type
			}),
			await Role.findOneOrFail({ where: { id: role_id, guild_id } }),
		]);
		member.roles = member.roles.filter((x) => x.id == role_id);

		await Promise.all([
			member.save(),
			emitEvent({
				event: "GUILD_MEMBER_UPDATE",
				data: {
					guild_id,
					user: member.user,
					roles: member.roles.map((x) => x.id),
				},
				guild_id,
			} as GuildMemberUpdateEvent),
		]);
	}

	static async changeNickname(
		user_id: string,
		guild_id: string,
		nickname: string,
	) {
		const member = await Member.findOneOrFail({
			where: {
				id: user_id,
				guild_id,
			},
			relations: ["user"],
		});
		member.nick = nickname;

		await Promise.all([
			member.save(),

			emitEvent({
				event: "GUILD_MEMBER_UPDATE",
				data: {
					guild_id,
					user: member.user,
					nick: nickname,
				},
				guild_id,
			} as GuildMemberUpdateEvent),
		]);
	}

	static async addToGuild(user_id: string, guild_id: string) {
		const user = await User.getPublicUser(user_id);
		const isBanned = await Ban.count({ where: { guild_id, user_id } });
		if (isBanned) {
			throw DiscordApiErrors.USER_BANNED;
		}
		const { maxGuilds } = Config.get().limits.user;
		const guild_count = await Member.count({ where: { id: user_id } });
		if (guild_count >= maxGuilds) {
			throw new HTTPError(
				`You are at the ${maxGuilds} server limit.`,
				403,
			);
		}

		const guild = await Guild.findOneOrFail({
			where: {
				id: guild_id,
			},
			relations: [...PublicGuildRelations, "system_channel"],
		});

		const memberCount = await Member.count({ where: { guild_id } });
		const memberPreview = await Member.find({
			where: {
				guild_id,
				user: {
					sessions: {
						status: Not("invisible" as "invisible"), // lol typescript?
					},
				},
			},
			take: 10,
		});

		if (
			await Member.count({
				where: { id: user.id, guild: { id: guild_id } },
			})
		)
			throw new HTTPError("You are already a member of this guild", 400);

		const member = {
			id: user_id,
			guild_id,
			nick: undefined,
			roles: [guild_id], // @everyone role
			joined_at: new Date(),
			deaf: false,
			mute: false,
			pending: false,
			bio: "",
		};

		await Promise.all([
			Member.create({
				...member,
				roles: [Role.create({ id: guild_id })],
				// read_state: {},
				settings: {
					guild_id: null,
					mute_config: null,
					mute_scheduled_events: false,
					flags: 0,
					hide_muted_channels: false,
					notify_highlights: 0,
					channel_overrides: {},
					message_notifications: 0,
					mobile_push: true,
					muted: false,
					suppress_everyone: false,
					suppress_roles: false,
					version: 0,
				},
				// Member.save is needed because else the roles relations wouldn't be updated
			}).save(),
			Guild.increment({ id: guild_id }, "member_count", 1),
			emitEvent({
				event: "GUILD_MEMBER_ADD",
				data: {
					...member,
					user,
					guild_id,
				},
				guild_id,
			} as GuildMemberAddEvent),
			emitEvent({
				event: "GUILD_CREATE",
				data: {
					...new ReadyGuildDTO(guild).toJSON(),
					members: [...memberPreview, { ...member, user }],
					member_count: memberCount + 1,
					guild_hashes: {},
					guild_scheduled_events: [],
					joined_at: member.joined_at,
					presences: [],
					stage_instances: [],
					threads: [],
					embedded_activities: [],
					voice_states: guild.voice_states,
				},
				user_id,
			} as GuildCreateEvent),
		]);

		if (guild.system_channel_id) {
			// send welcome message
			const message = Message.create({
				type: 7,
				guild_id: guild.id,
				channel_id: guild.system_channel_id,
				author: user,
				timestamp: new Date(),
				reactions: [],
				attachments: [],
				embeds: [],
				sticker_items: [],
				edited_timestamp: undefined,
			});
			await Promise.all([
				message.save(),
				emitEvent({
					event: "MESSAGE_CREATE",
					channel_id: message.channel_id,
					data: message,
				} as MessageCreateEvent),
			]);
		}
	}
}

export interface ChannelOverride {
	message_notifications: number;
	mute_config: MuteConfig;
	muted: boolean;
	channel_id: string | null;
}

export interface UserGuildSettings {
	// channel_overrides: {
	// 	channel_id: string;
	// 	message_notifications: number;
	// 	mute_config: MuteConfig;
	// 	muted: boolean;
	// }[];

	channel_overrides: {
		[channel_id: string]: ChannelOverride;
	} | null;
	message_notifications: number;
	mobile_push: boolean;
	mute_config: MuteConfig | null;
	muted: boolean;
	suppress_everyone: boolean;
	suppress_roles: boolean;
	version: number;
	guild_id: string | null;
	flags: number;
	mute_scheduled_events: boolean;
	hide_muted_channels: boolean;
	notify_highlights: 0;
}

export const DefaultUserGuildSettings: UserGuildSettings = {
	channel_overrides: null,
	message_notifications: 1,
	flags: 0,
	hide_muted_channels: false,
	mobile_push: true,
	mute_config: null,
	mute_scheduled_events: false,
	muted: false,
	notify_highlights: 0,
	suppress_everyone: false,
	suppress_roles: false,
	version: 453, // ?
	guild_id: null,
};

export interface MuteConfig {
	end_time: number;
	selected_time_window: number;
}

export type PublicMemberKeys =
	| "id"
	| "guild_id"
	| "nick"
	| "roles"
	| "joined_at"
	| "pending"
	| "deaf"
	| "mute"
	| "premium_since";

export const PublicMemberProjection: PublicMemberKeys[] = [
	"id",
	"guild_id",
	"nick",
	"roles",
	"joined_at",
	"pending",
	"deaf",
	"mute",
	"premium_since",
];

// @ts-ignore
export type PublicMember = Pick<Member, Omit<PublicMemberKeys, "roles">> & {
	user: PublicUser;
	roles: string[]; // only role ids not objects
};
