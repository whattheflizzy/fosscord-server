export type ChannelReorderSchema = {
	id: string;
	position?: number;
	lock_permissions?: boolean;
	parent_id?: string;
}[];
